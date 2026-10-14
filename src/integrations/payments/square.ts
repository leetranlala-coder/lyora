import { hmacBase64, safeEqual } from "../../util/ids.js";
import { WebhookAuthError } from "../messaging/provider.js";
import type { PaymentEvent, PaymentProvider } from "./provider.js";

/**
 * Square webhooks. Signature: `x-square-hmacsha256-signature` = base64(HMAC-SHA256(signature key, notification URL + raw body)).
 * The notification URL must be exactly the URL configured in the Square dashboard (SQUARE_WEBHOOK_URL).
 *
 * Handled: payment.updated / payment.created with status COMPLETED -> paid; refund.created/updated COMPLETED -> refunded;
 * dispute.created -> disputed. Put our product id in the payment `note` as "product:<id>" to link products.
 */
export class SquarePaymentProvider implements PaymentProvider {
  readonly name = "square" as const;
  constructor(private signatureKey: string, private notificationUrl: string) {}

  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<PaymentEvent[]> {
    if (!this.signatureKey || !this.notificationUrl) throw new WebhookAuthError("Square webhook not configured");
    const sig = headers["x-square-hmacsha256-signature"] ?? "";
    const expected = hmacBase64(this.signatureKey, this.notificationUrl + rawBody);
    if (!safeEqual(sig, expected)) throw new WebhookAuthError("bad signature");

    const evt = JSON.parse(rawBody) as { event_id: string; type: string; created_at?: string; data?: { object?: Record<string, any> } };
    const obj = evt.data?.object ?? {};
    const at = evt.created_at ?? new Date().toISOString();
    if (evt.type.startsWith("payment.")) {
      const p = obj.payment ?? {};
      if (p.status !== "COMPLETED") return [];
      const product = /product:([\w-]+)/.exec(p.note ?? "")?.[1];
      return [
        {
          provider: "square",
          event_id: evt.event_id,
          kind: "paid",
          transaction_id: String(p.id),
          amount: Number(p.amount_money?.amount ?? 0) / 100,
          currency: String(p.amount_money?.currency ?? "AUD"),
          email: p.buyer_email_address ?? null,
          product_ref: product ? { key: "id", value: product } : null,
          lead_ref: null,
          is_payment_plan: false,
          occurred_at: at,
        },
      ];
    }
    if (evt.type.startsWith("refund.")) {
      const r = obj.refund ?? {};
      if (r.status !== "COMPLETED") return [];
      return [
        {
          provider: "square",
          event_id: evt.event_id,
          kind: "refunded",
          transaction_id: String(r.payment_id),
          amount: Number(r.amount_money?.amount ?? 0) / 100,
          currency: String(r.amount_money?.currency ?? "AUD"),
          email: null,
          product_ref: null,
          lead_ref: null,
          is_payment_plan: false,
          occurred_at: at,
        },
      ];
    }
    if (evt.type === "dispute.created") {
      const d = obj.dispute ?? {};
      return [
        {
          provider: "square",
          event_id: evt.event_id,
          kind: "disputed",
          transaction_id: String(d.disputed_payment?.payment_id ?? d.id),
          amount: Number(d.amount_money?.amount ?? 0) / 100,
          currency: String(d.amount_money?.currency ?? "AUD"),
          email: null,
          product_ref: null,
          lead_ref: null,
          is_payment_plan: false,
          occurred_at: at,
        },
      ];
    }
    return [];
  }
}
