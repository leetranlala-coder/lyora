import { hmacHex, safeEqual } from "../../util/ids.js";
import { WebhookAuthError } from "../messaging/provider.js";
import type { PaymentEvent, PaymentProvider } from "./provider.js";

/**
 * Stripe webhooks (signature scheme: `Stripe-Signature: t=<ts>,v1=<hex hmac of "<ts>.<raw body>">`).
 *
 * Handled events:
 *   checkout.session.completed  -> paid
 *   charge.refunded             -> refunded
 *   charge.dispute.created      -> disputed
 *
 * To link a purchase to a lead/product, set Checkout Session metadata:
 *   metadata.product_id = <our product id>   (or map stripe price ids via products.external_ids.stripe_price_id)
 *   metadata.lead_id / metadata.instagram    (optional)
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  constructor(
    private secret: string,
    private toleranceSeconds = 300,
    private now: () => number = () => Date.now(),
  ) {}

  verify(header: string | undefined, rawBody: string) {
    if (!this.secret) throw new WebhookAuthError("STRIPE_WEBHOOK_SECRET not configured");
    if (!header) throw new WebhookAuthError("missing Stripe-Signature");
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    const t = parts.t;
    const sigs = header
      .split(",")
      .filter((kv) => kv.startsWith("v1="))
      .map((kv) => kv.slice(3));
    if (!t || !sigs.length) throw new WebhookAuthError("malformed Stripe-Signature");
    if (Math.abs(this.now() / 1000 - Number(t)) > this.toleranceSeconds) throw new WebhookAuthError("timestamp outside tolerance");
    const expected = hmacHex(this.secret, `${t}.${rawBody}`);
    if (!sigs.some((s) => safeEqual(s, expected))) throw new WebhookAuthError("bad signature");
  }

  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<PaymentEvent[]> {
    this.verify(headers["stripe-signature"], rawBody);
    const evt = JSON.parse(rawBody) as { id: string; type: string; created: number; data: { object: Record<string, any> } };
    const o = evt.data.object;
    const at = new Date((evt.created ?? Date.now() / 1000) * 1000).toISOString();
    const md = (o.metadata ?? {}) as Record<string, string>;
    const productRef = md.product_id
      ? { key: "id", value: md.product_id }
      : md.stripe_price_id
        ? { key: "stripe_price_id", value: md.stripe_price_id }
        : null;
    const leadRef = md.lead_id || md.instagram ? { lead_id: md.lead_id, username: md.instagram } : null;

    switch (evt.type) {
      case "checkout.session.completed":
        if (o.payment_status && o.payment_status !== "paid") return [];
        return [
          {
            provider: "stripe",
            event_id: evt.id,
            kind: "paid",
            transaction_id: String(o.payment_intent ?? o.subscription ?? o.id),
            amount: Number(o.amount_total ?? 0) / 100,
            currency: String(o.currency ?? "aud").toUpperCase(),
            email: o.customer_details?.email ?? o.customer_email ?? null,
            product_ref: productRef,
            lead_ref: leadRef,
            is_payment_plan: o.mode === "subscription" || md.payment_plan === "true",
            occurred_at: at,
          },
        ];
      case "charge.refunded":
      case "charge.dispute.created":
        return [
          {
            provider: "stripe",
            event_id: evt.id,
            kind: evt.type === "charge.refunded" ? "refunded" : "disputed",
            transaction_id: String(o.payment_intent ?? o.charge ?? o.id),
            amount: Number(o.amount_refunded ?? o.amount ?? 0) / 100,
            currency: String(o.currency ?? "aud").toUpperCase(),
            email: o.billing_details?.email ?? null,
            product_ref: productRef,
            lead_ref: leadRef,
            is_payment_plan: false,
            occurred_at: at,
          },
        ];
      default:
        return [];
    }
  }
}
