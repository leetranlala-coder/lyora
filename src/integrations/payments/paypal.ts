import { WebhookAuthError } from "../messaging/provider.js";
import type { PaymentEvent, PaymentProvider } from "./provider.js";

/**
 * PayPal webhooks. PayPal signatures are verified by calling PayPal's
 * /v1/notifications/verify-webhook-signature API with the transmission headers,
 * which needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID.
 *
 * Handled: PAYMENT.CAPTURE.COMPLETED -> paid, PAYMENT.CAPTURE.REFUNDED -> refunded,
 * CUSTOMER.DISPUTE.CREATED -> disputed. Put our product id in the order's custom_id to link products.
 */
export class PayPalPaymentProvider implements PaymentProvider {
  readonly name = "paypal" as const;
  constructor(
    private cfg: { clientId: string; clientSecret: string; webhookId: string; apiBase: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new WebhookAuthError(`paypal auth failed: HTTP ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private async verify(headers: Record<string, string | undefined>, event: unknown) {
    if (!this.cfg.clientId || !this.cfg.clientSecret || !this.cfg.webhookId) throw new WebhookAuthError("PayPal webhook not configured");
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.cfg.apiBase}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: this.cfg.webhookId,
        webhook_event: event,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { verification_status?: string };
    if (data.verification_status !== "SUCCESS") throw new WebhookAuthError("paypal signature not verified");
  }

  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<PaymentEvent[]> {
    const evt = JSON.parse(rawBody) as { id: string; event_type: string; create_time?: string; resource: Record<string, any> };
    await this.verify(headers, evt);
    const r = evt.resource ?? {};
    const at = evt.create_time ?? new Date().toISOString();
    const amount = Number(r.amount?.value ?? r.disputed_amount?.value ?? 0);
    const currency = String(r.amount?.currency_code ?? r.disputed_amount?.currency_code ?? "AUD");
    const productRef = r.custom_id ? { key: "id", value: String(r.custom_id) } : null;
    const base = { provider: "paypal" as const, event_id: evt.id, amount, currency, product_ref: productRef, lead_ref: null, is_payment_plan: false, occurred_at: at };
    switch (evt.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        // A capture's `payee` is the merchant (Lee), not the buyer — leads are matched via custom_id/product or manually.
        return [{ ...base, kind: "paid", transaction_id: String(r.id), email: null }];
      case "PAYMENT.CAPTURE.REFUNDED": {
        const captureLink = (r.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up")?.href;
        const captureId = captureLink?.split("/").pop() ?? String(r.id);
        return [{ ...base, kind: "refunded", transaction_id: captureId, email: null }];
      }
      case "CUSTOMER.DISPUTE.CREATED": {
        const txn = r.disputed_transactions?.[0]?.seller_transaction_id ?? r.dispute_id;
        return [{ ...base, kind: "disputed", transaction_id: String(txn), email: r.disputed_transactions?.[0]?.buyer?.email ?? null }];
      }
      default:
        return [];
    }
  }
}
