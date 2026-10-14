import type { LyoraAgent } from "./agent.js";
import { applyPurchaseToLead } from "./outcomes.js";
import { sendBatch, type SendOutcome } from "./sender.js";

/** Actions Lee can take from the dashboard. Every one is written to the audit log as actor=human. */
export class AdminActions {
  constructor(private agent: LyoraAgent) {}
  private get ctx() {
    return this.agent.ctx;
  }
  private now() {
    return this.ctx.clock.now().toISOString();
  }
  private audit(leadId: string | null, event: string, data?: unknown) {
    this.ctx.repos.audit.write({ lead_id: leadId, stage: "admin", event, data, actor: "human", now: this.now() });
  }

  takeOver(leadId: string) {
    this.agent.setTakeover(leadId, true, "taken over from dashboard");
  }

  resumeAi(leadId: string): { ok: boolean; warning?: string } {
    const lead = this.ctx.repos.leads.get(leadId);
    if (!lead) return { ok: false };
    this.agent.setTakeover(leadId, false, "resumed from dashboard");
    const now = this.now();
    this.ctx.repos.leads.update(leadId, { handoff_resolved_at: lead.handoff_required ? now : lead.handoff_resolved_at });
    if (lead.automation_status === "stopped") {
      if (lead.stop_reason === "asked not to be contacted") {
        return { ok: true, warning: "she asked not to be contacted — automation stays stopped" };
      }
      this.ctx.repos.leads.update(leadId, { automation_status: "active", stop_reason: null, updated_at: now });
      this.audit(leadId, "automation_reactivated", { previous_stop_reason: lead.stop_reason });
    }
    return { ok: true };
  }

  markNotInterested(leadId: string) {
    const now = this.now();
    this.ctx.repos.leads.update(leadId, { status: "not_interested", automation_status: "stopped", stop_reason: "not interested", follow_up_due_at: null, updated_at: now });
    this.ctx.repos.followUps.cancelAllForLead(leadId, "marked not interested", now);
    this.ctx.repos.outbound.discardPendingForLead(leadId);
    this.audit(leadId, "marked_not_interested");
  }

  markPurchased(leadId: string, input: { productId: string | null; amount: number; paymentPlan: boolean }) {
    const lead = this.ctx.repos.leads.get(leadId);
    if (!lead) return;
    const now = this.now();
    this.ctx.repos.purchases.insert(
      {
        lead_id: leadId,
        product_id: input.productId,
        provider: "manual",
        provider_transaction_id: `manual_${leadId}_${now}`,
        amount: input.amount,
        currency: "AUD",
        status: "paid",
        is_payment_plan: input.paymentPlan,
        customer_email: lead.email,
        attribution: lead.human_takeover_at ? "human_assisted" : "unattributed",
        purchased_at: now,
      },
      now,
    );
    applyPurchaseToLead(this.ctx, lead, input.amount, input.productId, "marked purchased by lee");
    this.ctx.repos.leads.update(leadId, { handoff_resolved_at: lead.handoff_required ? now : lead.handoff_resolved_at });
    this.audit(leadId, "marked_purchased", input);
  }

  markCallBooked(leadId: string) {
    const now = this.now();
    this.ctx.repos.leads.update(leadId, { call_booked: true, status: "call_booked", automation_status: "stopped", stop_reason: "call booked", updated_at: now });
    this.ctx.repos.followUps.cancelAllForLead(leadId, "call booked", now);
    this.audit(leadId, "marked_call_booked");
  }

  resolveHandoff(leadId: string) {
    this.ctx.repos.leads.update(leadId, { handoff_resolved_at: this.now(), updated_at: this.now() });
    this.audit(leadId, "handoff_resolved");
  }

  cancelFollowUp(followUpId: string) {
    const fu = this.ctx.repos.followUps.get(followUpId);
    if (!fu || fu.status !== "scheduled") return;
    this.ctx.repos.followUps.setStatus(followUpId, "cancelled", "cancelled by lee", this.now());
    this.ctx.repos.leads.update(fu.lead_id, { follow_up_due_at: null });
    this.audit(fu.lead_id, "followup_cancelled", { followUpId });
  }

  /** Approve (optionally edited) draft bubbles and send them. */
  async approveDraft(batchId: string, edited?: string[]): Promise<SendOutcome> {
    const rows = this.ctx.repos.outbound.batch(batchId);
    if (!rows.length) return { status: "blocked", reason: "draft not found" };
    if (edited) {
      rows.forEach((r, i) => {
        const text = edited[i]?.trim();
        if (text === undefined || text === "") this.ctx.repos.outbound.update(r.id, { status: "discarded" });
        else if (text !== r.content) this.ctx.repos.outbound.update(r.id, { content: text, edited_by_human: true });
      });
    }
    this.audit(rows[0]!.lead_id, "draft_approved", { batchId, edited: !!edited });
    return sendBatch(this.ctx, batchId, "human");
  }

  discardDraft(batchId: string) {
    const rows = this.ctx.repos.outbound.batch(batchId);
    for (const r of rows) if (r.status !== "sent") this.ctx.repos.outbound.update(r.id, { status: "discarded" });
    if (rows[0]) this.audit(rows[0].lead_id, "draft_discarded", { batchId });
  }

  matchPurchase(purchaseId: string, leadId: string) {
    const p = this.ctx.repos.db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as { amount: number; product_id: string | null } | undefined;
    const lead = this.ctx.repos.leads.get(leadId);
    if (!p || !lead) return;
    this.ctx.repos.db.prepare("UPDATE purchases SET lead_id = ? WHERE id = ?").run(leadId, purchaseId);
    applyPurchaseToLead(this.ctx, lead, Number(p.amount), p.product_id, "purchase matched manually");
    this.audit(leadId, "purchase_matched", { purchaseId });
  }
}
