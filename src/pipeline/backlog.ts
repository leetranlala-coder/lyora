import { sha256 } from "../util/ids.js";
import type { LyoraAgent, ProcessResult } from "./agent.js";

/**
 * Backlog: conversations from before the agent existed (or older than Instagram's 24h window).
 * Lee pastes the conversation, the agent drafts a reply in "manual" mode, and Lee copies it into
 * Instagram herself. Nothing here is ever sent through the API.
 */

export interface PastedLine {
  direction: "inbound" | "outbound";
  content: string;
}

const ME = /^\s*(me|lee|you|lyora|lyora\.nails|@lyora\.nails)\s*[:\-–]\s*/i;
const HER = /^\s*(her|them|lead|she|client|customer)\s*[:\-–]\s*/i;

/**
 * Turn pasted text into messages.
 * Lines starting "me:" / "lee:" / "you:" are Lee's; "her:" / "them:" / "<name>:" are the lead's.
 * Lines without a label continue the previous message. With no labels at all, everything is hers.
 */
export function parseConversation(text: string, handle?: string): PastedLine[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: PastedLine[] = [];
  const handleRe = handle ? new RegExp(`^\\s*@?${handle.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–]\\s*`, "i") : null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (ME.test(line)) {
      out.push({ direction: "outbound", content: line.replace(ME, "").trim() });
    } else if ((handleRe && handleRe.test(line)) || HER.test(line)) {
      out.push({ direction: "inbound", content: line.replace(handleRe && handleRe.test(line) ? handleRe : HER, "").trim() });
    } else if (out.length) {
      out[out.length - 1]!.content += "\n" + line.trim();
    } else {
      out.push({ direction: "inbound", content: line.trim() });
    }
  }
  return out.filter((m) => m.content);
}

export async function importBacklogConversation(
  agent: LyoraAgent,
  input: { handle: string; name?: string | null; text: string },
): Promise<{ leadId: string; added: number; result: ProcessResult | { status: "no_new_messages" } }> {
  const { repos } = agent.ctx;
  const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
  if (!handle) throw new Error("instagram handle is required");
  const lines = parseConversation(input.text, handle);
  if (!lines.some((l) => l.direction === "inbound")) throw new Error("couldn't find any messages from her in that text");

  const now = agent.ctx.clock.now();
  const existing = repos.leads.findByUsername(handle);
  const lead =
    existing ??
    repos.leads.upsertFromChannel({
      platform: "instagram",
      platform_user_id: `manual:${handle}`,
      username: handle,
      display_name: input.name?.trim() || null,
      source: "backlog",
      now: now.toISOString(),
    });

  // Same line pasted twice (e.g. re-pasting a longer version of the chat) is only stored once.
  const seen = new Map<string, number>();
  let added = 0;
  let lastInbound: string | null = null;
  lines.forEach((l, i) => {
    const key = `${l.direction}|${l.content}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const id = `manual:${lead.id}:${sha256(`${key}|${n}`).slice(0, 24)}`;
    const at = new Date(now.getTime() - (lines.length - i) * 1000).toISOString();
    if (repos.messages.existsByPlatformId(lead.platform, id)) return;
    if (l.direction === "inbound") {
      if (repos.messages.insertInbound({ lead_id: lead.id, platform: lead.platform, platform_message_id: id, content: l.content, created_at: at })) {
        added++;
        lastInbound = at;
      }
    } else {
      // Lee's own earlier replies: part of the history, already sent by her.
      if (repos.messages.insertOutbound({ lead_id: lead.id, platform: lead.platform, platform_message_id: id, content: l.content, sender_type: "human", created_at: at })) added++;
    }
  });

  if (lastInbound) {
    // needs_processing stays off: only this manual run may draft for it, never the automatic check.
    repos.leads.update(lead.id, { last_inbound_message_at: lastInbound, updated_at: now.toISOString() });
  }
  repos.audit.write({ lead_id: lead.id, stage: "admin", event: "backlog_imported", data: { lines: lines.length, added }, actor: "human", now: now.toISOString() });

  if (!repos.messages.unprocessedInbound(lead.id).length) return { leadId: lead.id, added, result: { status: "no_new_messages" } };
  const result = await agent.processLead(lead.id, { ignoreQuietPeriod: true, manual: true });
  return { leadId: lead.id, added, result };
}
