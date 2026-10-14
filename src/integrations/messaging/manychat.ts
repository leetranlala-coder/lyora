import type { Lead } from "../../domain/types.js";
import { safeEqual, sha256 } from "../../util/ids.js";
import { WebhookAuthError, type MessagingProvider, type ParsedWebhook } from "./provider.js";

/**
 * ManyChat bridge for Instagram DMs.
 *
 * Inbound: in ManyChat, add an "External Request" action (e.g. in a Default Reply / keyword flow)
 * that POSTs JSON to  {PUBLIC_BASE_URL}/webhooks/manychat  with header
 *   X-Lyora-Secret: <MANYCHAT_WEBHOOK_SECRET>
 * and body (use ManyChat's dynamic fields):
 *   { "subscriber_id": "{{user_id}}", "username": "{{ig_username}}", "name": "{{full_name}}",
 *     "email": "{{email}}", "text": "{{last_input_text}}", "message_id": "<optional unique id>",
 *     "source": "<flow / keyword name>" }
 *
 * Outbound: ManyChat's sending API (POST /fb/sending/sendContent) with your API key.
 * ManyChat applies Instagram's 24h messaging window; sends outside it will be rejected.
 *
 * ManyChat does not expose full DM history through its API, so this system keeps its own
 * conversation record. Check field names against ManyChat's current API docs before going live.
 */
export class ManyChatProvider implements MessagingProvider {
  readonly name = "manychat";
  readonly platform = "instagram";

  constructor(
    private cfg: { apiKey: string; webhookSecret: string; baseUrl?: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook {
    const secret = headers["x-lyora-secret"] ?? "";
    if (!this.cfg.webhookSecret) throw new WebhookAuthError("MANYCHAT_WEBHOOK_SECRET not configured");
    if (!safeEqual(secret, this.cfg.webhookSecret)) throw new WebhookAuthError("bad secret");
    const b = lenientParse(rawBody);
    const subscriber = String(b.subscriber_id ?? "").replace(/[^0-9A-Za-z_-]/g, "");
    if (!subscriber) return { inbound: [], echoes: [] };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    const sentAt = typeof b.timestamp === "string" ? b.timestamp : new Date().toISOString();
    const clean = (v: unknown) => {
      const s = typeof v === "string" ? v.trim() : "";
      return s && !s.startsWith("{") ? s : null;
    };
    // Text may be empty here: enrich() then looks it up from ManyChat by contact id.
    return {
      inbound: [
        {
          platform: "instagram",
          platform_user_id: subscriber,
          platform_message_id: b.message_id ? String(b.message_id) : text ? messageIdFor(subscriber, text, sentAt) : "",
          text,
          sent_at: sentAt,
          username: clean(b.username),
          display_name: clean(b.name),
          email: clean(b.email),
          source: clean(b.source) ?? "manychat",
        },
      ],
      echoes: [],
    };
  }

  /** Fill in the message text (and profile) from ManyChat when the webhook only carried the contact id. */
  async enrich(parsed: ParsedWebhook): Promise<ParsedWebhook> {
    const inbound = [];
    for (const e of parsed.inbound) {
      if (e.text) {
        inbound.push(e);
        continue;
      }
      const info = await this.getSubscriberInfo(e.platform_user_id);
      const text = typeof info?.last_input_text === "string" ? info.last_input_text.trim() : "";
      if (!text) continue;
      const at = typeof info?.last_interaction === "string" && info.last_interaction ? info.last_interaction : e.sent_at;
      inbound.push({
        ...e,
        text,
        platform_message_id: messageIdFor(e.platform_user_id, text, at),
        username: e.username ?? (typeof info?.ig_username === "string" ? info.ig_username : null),
        display_name: e.display_name ?? (typeof info?.name === "string" ? info.name : null),
        email: e.email ?? (typeof info?.email === "string" && info.email ? info.email : null),
      });
    }
    return { inbound, echoes: parsed.echoes };
  }

  private async getSubscriberInfo(subscriberId: string): Promise<Record<string, unknown> | null> {
    if (!this.cfg.apiKey) throw new Error("MANYCHAT_API_KEY not configured");
    const url = `${this.cfg.baseUrl ?? "https://api.manychat.com"}/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`;
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.cfg.apiKey}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`manychat getInfo failed: HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string; data?: Record<string, unknown> };
    return body.data ?? null;
  }

  async sendMessage(lead: Lead, text: string, _idempotencyKey: string) {
    const res = await this.fetchImpl(`${this.cfg.baseUrl ?? "https://api.manychat.com"}/fb/sending/sendContent`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        subscriber_id: lead.platform_user_id,
        data: { version: "v2", content: { type: "instagram", messages: [{ type: "text", text }] } },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (!res.ok || data.status === "error") throw new Error(`manychat send failed: HTTP ${res.status}`);
    // ManyChat doesn't return a message id; use a deterministic local one.
    return { providerMessageId: `mc_out_${sha256(`${lead.platform_user_id}|${text}|${Date.now()}`).slice(0, 24)}` };
  }
}

/** Stable id for a ManyChat message (ManyChat doesn't send one): contact + text + minute. */
function messageIdFor(subscriber: string, text: string, at: string): string {
  return `mc_${sha256(`${subscriber}|${text}|${at.slice(0, 16)}`).slice(0, 32)}`;
}

/**
 * ManyChat's body editor makes it easy to end up with slightly broken JSON (doubled quotes from
 * to_json, extra closing braces). Try strict JSON first, then fall back to pulling out the fields.
 */
export function lenientParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const trimmed = raw.trim().replace(/\}+\s*$/, "}");
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const id = /"subscriber_id"\s*:\s*"*\s*([0-9A-Za-z_-]+)/.exec(raw)?.[1];
  // Text is NOT extracted from broken JSON (it may contain quotes) — enrich() looks it up instead.
  return id ? { subscriber_id: id } : {};
}
