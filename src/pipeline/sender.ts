import type { OutboundMessage } from "../domain/types.js";
import { hoursBetween } from "../util/time.js";
import { log } from "../logger.js";
import type { AgentContext } from "./context.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SendOutcome =
  | { status: "sent"; sent: number }
  | { status: "blocked"; reason: string }
  | { status: "failed"; error: string; sent: number };

/**
 * Send one batch of DM bubbles in order. Re-checks every safeguard immediately before sending,
 * because time may have passed since the batch was drafted.
 *
 * actor = "agent"  -> automatic send (strict: takeover/stop/newer-inbound all block)
 * actor = "human"  -> Lee approved it in the dashboard (she has seen the conversation)
 */
export async function sendBatch(ctx: AgentContext, batchId: string, actor: "agent" | "human"): Promise<SendOutcome> {
  const { repos } = ctx;
  const nowIso = () => ctx.clock.now().toISOString();
  const rows = repos.outbound.batch(batchId).filter((r) => r.status !== "discarded");
  const pending = rows.filter((r) => r.status !== "sent");
  if (!pending.length) return { status: "sent", sent: 0 };
  const lead = repos.leads.get(pending[0]!.lead_id);
  if (!lead) return { status: "blocked", reason: "lead not found" };

  const block = (reason: string, discard: boolean): SendOutcome => {
    if (discard) for (const r of pending) repos.outbound.update(r.id, { status: "discarded", error: reason });
    repos.audit.write({ lead_id: lead.id, stage: "send", event: "blocked", data: { batchId, reason, actor }, actor, now: nowIso() });
    return { status: "blocked", reason };
  };

  if (actor === "agent") {
    if (ctx.cfg.SEND_MODE !== "auto") return block("draft mode — waiting for approval", false);
    if (!ctx.cfg.AGENT_ENABLED) return block("agent disabled", false);
    if (lead.human_takeover) return block("human takeover enabled", true);
    const closing = pending[0]!.decision_action === "MARK_NOT_INTERESTED";
    if (lead.automation_status === "stopped" && !closing) return block(`automation stopped (${lead.stop_reason})`, true);
    if (lead.handoff_required && !lead.handoff_resolved_at) return block("handoff open — lee is handling it", true);
    const created = pending[0]!.created_at;
    if (lead.last_inbound_message_at && lead.last_inbound_message_at > created) {
      return block("superseded by a newer message from the lead", true);
    }
  }
  if (lead.last_inbound_message_at && hoursBetween(lead.last_inbound_message_at, ctx.clock.now()) > ctx.cfg.MESSAGING_WINDOW_HOURS) {
    for (const r of pending) repos.outbound.update(r.id, { status: "failed", error: "outside the 24h messaging window" });
    return block("outside the platform's 24h messaging window — reply manually in the app", false);
  }

  let sent = 0;
  for (const row of pending.sort((a, b) => a.position - b.position)) {
    // Another worker may have sent it between our read and now.
    const fresh = repos.outbound.get(row.id);
    if (!fresh || fresh.status === "sent" || fresh.status === "discarded") continue;
    repos.outbound.update(row.id, { attempts: fresh.attempts + 1 });
    try {
      const { providerMessageId } = await ctx.messaging.sendMessage(lead, fresh.content, fresh.idempotency_key);
      const at = nowIso();
      repos.outbound.update(row.id, { status: "sent", provider_message_id: providerMessageId, sent_at: at, error: null });
      repos.messages.insertOutbound({
        lead_id: lead.id,
        platform: lead.platform,
        platform_message_id: providerMessageId,
        content: fresh.content,
        sender_type: "ai",
        outbound_message_id: row.id,
        created_at: at,
      });
      repos.leads.update(lead.id, {
        last_outbound_message_at: at,
        first_response_at: lead.first_response_at ?? at,
        updated_at: at,
      });
      sent++;
      if (ctx.cfg.BUBBLE_DELAY_MS > 0 && row !== pending[pending.length - 1]) await sleep(ctx.cfg.BUBBLE_DELAY_MS);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      repos.outbound.update(row.id, { status: "failed", error });
      log.warn("send failed", { leadId: lead.id, batchId, error });
      repos.audit.write({ lead_id: lead.id, stage: "send", event: "failed", data: { batchId, outboundId: row.id, error }, actor, now: nowIso() });
      return { status: "failed", error, sent };
    }
  }
  repos.audit.write({ lead_id: lead.id, stage: "send", event: "sent", data: { batchId, bubbles: sent }, actor, now: nowIso() });
  return { status: "sent", sent };
}

export function pendingOutbound(ctx: AgentContext, leadId: string): OutboundMessage[] {
  return ctx.repos.outbound.forLead(leadId).filter((o) => o.status === "draft" || o.status === "queued");
}
