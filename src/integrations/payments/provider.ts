/** Normalised payment event from any provider. */
export interface PaymentEvent {
  provider: "stripe" | "paypal" | "kajabi" | "square" | "manual";
  event_id: string; // provider event id, for webhook de-duplication
  kind: "paid" | "refunded" | "disputed";
  transaction_id: string; // stable id of the payment (payment intent, capture id, ...)
  amount: number; // major units (dollars)
  currency: string;
  email: string | null;
  /** How to find the product: e.g. {key: "stripe_price_id", value: "price_123"} or {key: "id", value: "<our product id>"} */
  product_ref: { key: string; value: string } | null;
  /** Direct lead hints passed through checkout metadata, if configured. */
  lead_ref: { lead_id?: string; username?: string } | null;
  is_payment_plan: boolean;
  occurred_at: string;
}

export interface PaymentProvider {
  readonly name: PaymentEvent["provider"];
  /** Verify the webhook and return zero or more normalised events. Throws WebhookAuthError on bad signature. */
  handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<PaymentEvent[]>;
  /** Optional server-side confirmation of a purchase. */
  verifyPurchase?(transactionId: string): Promise<boolean>;
}
