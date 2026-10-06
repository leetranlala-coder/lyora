import type { Lead } from "../../domain/types.js";
import { hmacHex, safeEqual } from "../../util/ids.js";
import { WebhookAuthError, type EchoEvent, type InboundEvent, type MessagingProvider, type ParsedWebhook } from "./provider.js";

/**
 * Instagram Messaging via Meta's official API (Instagram API with Instagram Login / Messenger Platform).
 *
 * - Webhooks: Meta signs the raw body with your app secret in `X-Hub-Signature-256: sha256=<hex>`.
 * - Echoes: messages Lee sends from the Instagram app arrive with `message.is_echo = true`.
 * - Sending: POST {graph}/{ig-user-id}/messages with a page/IG access token.
 *
 * IMPORTANT: Meta only allows automated replies inside the 24-hour window after the lead's
 * last message. The follow-up engine enforces this (MESSAGING_WINDOW_HOURS).
 *
 * Verify endpoint paths/versions against Meta's current docs before going live — they change.
 */
export class MetaInstagramProvider implements MessagingProvider {
  readonly name = "meta";
  readonly platform = "instagram";

  constructor(
    private cfg: { appSecret: string; accessToken: string; igUserId: string; graphBaseUrl: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  verifySignature(headers: Record<string, string | undefined>, rawBody: string) {
    const header = headers["x-hub-signature-256"];
    if (!this.cfg.appSecret) throw new WebhookAuthError("META_APP_SECRET not configured");
    if (!header?.startsWith("sha256=")) throw new WebhookAuthError("missing signature");
    const expected = "sha256=" + hmacHex(this.cfg.appSecret, rawBody);
    if (!safeEqual(header, expected)) throw new WebhookAuthError("bad signature");
  }

  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook {
    this.verifySignature(headers, rawBody);
    const body = JSON.parse(rawBody) as {
      entry?: {
        id?: string;
        messaging?: {
          sender?: { id?: string };
          recipient?: { id?: string };
          timestamp?: number;
          message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
        }[];
      }[];
    };
    const inbound: InboundEvent[] = [];
    const echoes: EchoEvent[] = [];
    for (const entry of body.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const msg = ev.message;
        if (!msg?.mid || msg.is_deleted) continue;
        const sentAt = new Date(ev.timestamp ?? Date.now()).toISOString();
        const text = msg.text ?? "[non-text message]";
        if (msg.is_echo) {
          echoes.push({ platform: "instagram", platform_user_id: String(ev.recipient?.id), platform_message_id: msg.mid, text, sent_at: sentAt });
        } else {
          inbound.push({ platform: "instagram", platform_user_id: String(ev.sender?.id), platform_message_id: msg.mid, text, sent_at: sentAt });
        }
      }
    }
    return { inbound, echoes };
  }

  async sendMessage(lead: Lead, text: string, _idempotencyKey: string) {
    const url = `${this.cfg.graphBaseUrl.replace(/\/$/, "")}/${this.cfg.igUserId || "me"}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.accessToken}` },
      body: JSON.stringify({ recipient: { id: lead.platform_user_id }, message: { text } }),
    });
    if (!res.ok) throw new Error(`meta send failed: HTTP ${res.status}`);
    const data = (await res.json()) as { message_id?: string };
    if (!data.message_id) throw new Error("meta send: no message_id in response");
    return { providerMessageId: data.message_id };
  }
}

/** Handles Meta's GET verification handshake (hub.challenge). */
export function metaVerifyChallenge(query: URLSearchParams, verifyToken: string): string | null {
  if (!verifyToken) return null;
  if (query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === verifyToken) {
    return query.get("hub.challenge");
  }
  return null;
}
