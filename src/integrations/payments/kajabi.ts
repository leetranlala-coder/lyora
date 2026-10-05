import { safeEqual } from "../../util/ids.js";
import { WebhookAuthError } from "../messaging/provider.js";
import type { PaymentEvent, PaymentProvider } from "./provider.js";

/**
 * Kajabi purchases.
 *
 * Kajabi's outbound webhook payloads are not assumed here. Instead this endpoint accepts a
 * small, documented JSON shape that you send from Kajabi (Automations → webhook, if your plan
 * supports it) or from Zapier/Make ("Kajabi: New Purchase" → "Webhooks: POST"):
 *
 *   POST {PUBLIC_BASE_URL}/webhooks/kajabi
 *   X-Lyora-Secret: <KAJABI_WEBHOOK_SECRET>
 *   { "event": "purchase" | "refund" | "dispute",
 *     "id": "<unique purchase/event id>",
 *     "offer_id": "<kajabi offer id>",
 *     "amount": 450, "currency": "AUD",
 *     "email": "student@example.com",
 *     "instagram": "@handle",            (optional — e.g. from a checkout custom field)
 *     "payment_plan": false }
 *
 * Products are linked through products.external_ids.kajabi_offer_id.
 */
export class KajabiPaymentProvider implements PaymentProvider {
  readonly name = "kajabi" as const;
  constructor(private secret: string) {}

  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<PaymentEvent[]> {
    if (!this.secret) throw new WebhookAuthError("KAJABI_WEBHOOK_SECRET not configured");
    if (!safeEqual(headers["x-lyora-secret"] ?? "", this.secret)) throw new WebhookAuthError("bad secret");
    const b = JSON.parse(rawBody) as Record<string, unknown>;
    const kind = b.event === "refund" ? "refunded" : b.event === "dispute" ? "disputed" : b.event === "purchase" ? "paid" : null;
    if (!kind || !b.id) return [];
    return [
      {
        provider: "kajabi",
        event_id: `${b.event}:${b.id}`,
        kind,
        transaction_id: String(b.id),
        amount: Number(b.amount ?? 0),
        currency: String(b.currency ?? "AUD").toUpperCase(),
        email: typeof b.email === "string" ? b.email : null,
        product_ref: b.offer_id ? { key: "kajabi_offer_id", value: String(b.offer_id) } : null,
        lead_ref: typeof b.instagram === "string" && b.instagram ? { username: b.instagram.replace(/^@/, "") } : null,
        is_payment_plan: b.payment_plan === true || b.payment_plan === "true",
        occurred_at: typeof b.purchased_at === "string" ? b.purchased_at : new Date().toISOString(),
      },
    ];
  }
}
