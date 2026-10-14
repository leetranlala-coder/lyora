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
    const b = JSON.parse(rawBody) as Record<string, unknown>;
    const subscriber = String(b.subscriber_id ?? "");
    const text = String(b.text ?? "").trim();
    if (!subscriber || !text) return { inbound: [], echoes: [] };
    const sentAt = typeof b.timestamp === "string" ? b.timestamp : new Date().toISOString();
    // If ManyChat can't supply a message id, derive one from subscriber + text + minute so a
    // retried webhook is de-duplicated (two identical messages in the same minute collapse to one).
    const messageId = b.message_id ? String(b.message_id) : `mc_${sha256(`${subscriber}|${text}|${sentAt.slice(0, 16)}`).slice(0, 32)}`;
    const clean = (v: unknown) => {
      const s = typeof v === "string" ? v.trim() : "";
      return s && !s.startsWith("{{") ? s : null;
    };
    return {
      inbound: [
        {
          platform: "instagram",
          platform_user_id: subscriber,
          platform_message_id: messageId,
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
