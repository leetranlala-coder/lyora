import type { Lead } from "../domain/types.js";
import type { PaymentEvent } from "../integrations/payments/provider.js";
import type { BookingEvent } from "../integrations/booking/provider.js";
import type { AgentContext } from "./context.js";

/** Find the lead behind a payment/booking: explicit id, then email, then instagram handle. */
export function matchLead(ctx: AgentContext, hints: { lead_id?: string | null; email?: string | null; username?: string | null }): Lead | null {
  const { leads } = ctx.repos;
  if (hints.lead_id) {
    const l = leads.get(hints.lead_id);
    if (l) return l;
  }
  if (hints.email) {
    const l = leads.findByEmail(hints.email);
    if (l) return l;
  }
  if (hints.username) {
    const l = leads.findByUsername(hints.username);
    if (l) return l;
  }
  return null;
}

/**
 * Attribution is descriptive, not causal: it records who was talking to the lead before
 * the purchase. "ai_assisted" means the AI sent messages and Lee didn't; it does NOT mean
 * the AI caused the sale.
 */
function attributionFor(ctx: AgentContext, lead: Lead, purchasedAt: string): "ai_assisted" | "human_assisted" | "unattributed" {
  const before = ctx.repos.messages.forLead(lead.id).filter((m) => m.direction === "outbound" && m.created_at <= purchasedAt);
  if (before.some((m) => m.human_generated) || (lead.human_takeover_at && lead.human_takeover_at <= purchasedAt)) return "human_assisted";
  if (before.some((m) => m.ai_generated)) return "ai_assisted";
  return "unattributed";
}

export function recordPayment(ctx: AgentContext, evt: PaymentEvent): { status: "duplicate" | "recorded" | "unmatched"; leadId?: string } {
  const { repos } = ctx;
  const now = ctx.clock.now().toISOString();
  if (!repos.webhookEvents.markReceived(evt.provider, evt.event_id, now)) return { status: "duplicate" };

  const product = evt.product_ref
    ? evt.product_ref.key === "id"
      ? repos.products.getProductById(evt.product_ref.value)
      : repos.products.findByExternalId(evt.product_ref.key, evt.product_ref.value)
    : null;

  if (evt.kind === "refunded" || evt.kind === "disputed") {
    const existing = repos.purchases.findByTxn(evt.provider, evt.transaction_id);
    repos.purchases.setStatus(evt.provider, evt.transaction_id, evt.kind);
    const lead = existing?.lead_id ? repos.leads.get(existing.lead_id) : matchLead(ctx, { email: evt.email, ...evt.lead_ref });
    if (lead) {
      repos.leads.update(lead.id, { automation_status: "stopped", stop_reason: evt.kind, updated_at: now });
      repos.followUps.cancelAllForLead(lead.id, evt.kind, now);
      repos.outbound.discardPendingForLead(lead.id);
      repos.leads.setHandoff(lead.id, evt.kind === "refunded" ? "refund processed" : "payment dispute opened", "urgent", now);
    }
    repos.audit.write({ lead_id: lead?.id, stage: "webhook", event: `payment_${evt.kind}`, data: { provider: evt.provider, txn: evt.transaction_id, amount: evt.amount }, actor: "system", now });
    return { status: lead ? "recorded" : "unmatched", leadId: lead?.id };
  }

  const lead = matchLead(ctx, { email: evt.email, ...evt.lead_ref });
  const { purchase, created } = repos.purchases.insert(
    {
      lead_id: lead?.id ?? null,
      product_id: product?.id ?? null,
      provider: evt.provider,
      provider_transaction_id: evt.transaction_id,
      amount: evt.amount,
      currency: evt.currency,
      status: "paid",
      is_payment_plan: evt.is_payment_plan,
      customer_email: evt.email,
      attribution: lead ? attributionFor(ctx, lead, evt.occurred_at) : null,
      purchased_at: evt.occurred_at,
    },
    now,
  );
  if (!created) return { status: "duplicate" };
  if (lead) applyPurchaseToLead(ctx, lead, purchase.amount, product?.id ?? null, `${evt.provider} payment`);
  repos.audit.write({
    lead_id: lead?.id,
    stage: "webhook",
    event: lead ? "purchase_recorded" : "purchase_unmatched",
    data: { provider: evt.provider, product: product?.id ?? null, amount: evt.amount, payment_plan: evt.is_payment_plan },
    actor: "system",
    now,
  });
  return { status: lead ? "recorded" : "unmatched", leadId: lead?.id };
}

/** Mark a lead as a customer: stop selling, cancel sales follow-ups, record value. */
export function applyPurchaseToLead(ctx: AgentContext, lead: Lead, amount: number, productId: string | null, reason: string) {
  const { repos } = ctx;
  const now = ctx.clock.now().toISOString();
  const fresh = repos.leads.get(lead.id)!;
  repos.leads.update(lead.id, {
    purchased: true,
    status: "purchased",
    customer_value: fresh.customer_value + amount,
    automation_status: "stopped",
    stop_reason: "purchased",
    recommended_offer: null,
    follow_up_due_at: null,
    updated_at: now,
  });
  repos.followUps.cancelAllForLead(lead.id, "purchased", now);
  repos.outbound.discardPendingForLead(lead.id);
  if (productId) repos.offers.record(lead.id, productId, "PURCHASED", now);
  repos.audit.write({ lead_id: lead.id, stage: "webhook", event: "marked_purchased", data: { amount, productId, reason }, actor: "system", now });
}

export function recordBooking(ctx: AgentContext, evt: BookingEvent): { status: "duplicate" | "recorded" | "unmatched"; leadId?: string } {
  const { repos } = ctx;
  const now = ctx.clock.now().toISOString();
  if (!repos.webhookEvents.markReceived(evt.provider, evt.event_id, now)) return { status: "duplicate" };
  const lead = matchLead(ctx, { email: evt.email, username: evt.instagram });
  repos.bookings.upsert({
    lead_id: lead?.id ?? null,
    provider: evt.provider,
    provider_booking_id: evt.booking_id,
    invitee_email: evt.email,
    starts_at: evt.starts_at,
    status: evt.status,
    now,
  });
  if (lead) {
    if (evt.status === "booked") {
      repos.leads.update(lead.id, {
        call_booked: true,
        status: "call_booked",
        automation_status: "stopped",
        stop_reason: "call booked",
        email: lead.email ?? evt.email,
        updated_at: now,
      });
      repos.followUps.cancelAllForLead(lead.id, "call booked", now);
      repos.outbound.discardPendingForLead(lead.id);
    } else {
      repos.leads.update(lead.id, { call_booked: false, updated_at: now });
      repos.leads.setHandoff(lead.id, "call cancelled — decide whether to reach out", "normal", now);
    }
  }
  repos.audit.write({ lead_id: lead?.id, stage: "webhook", event: `booking_${evt.status}`, data: { provider: evt.provider, starts_at: evt.starts_at }, actor: "system", now });
  return { status: lead ? "recorded" : "unmatched", leadId: lead?.id };
}
