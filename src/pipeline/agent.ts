import { MESSAGE_ACTIONS, type Lead, type LeadAnalysis, type Message, type SalesAction, type SalesDecision } from "../domain/types.js";
import { detectSignalsAcross, type Signals } from "../agents/signals.js";
import { clamp, scoreLead, type ScoreBreakdown } from "../agents/scoring.js";
import { buildCatalogue, buildFacts } from "../agents/facts.js";
import { decide } from "../agents/supervisor.js";
import { LLMUnavailableError } from "../llm/provider.js";
import type { EchoEvent, InboundEvent, ParsedWebhook } from "../integrations/messaging/provider.js";
import { newId } from "../util/ids.js";
import { log } from "../logger.js";
import type { AgentContext } from "./context.js";
import { composeValidated } from "./compose.js";
import { sendBatch } from "./sender.js";
import { followUpBlocker, inSendHours, outsideMessagingWindow, scheduleFollowUp } from "./followups.js";
import { nextTimeInWindow } from "../util/time.js";

/**
 * LYORA DM agent.
 *
 *   ingest -> match lead -> store raw message -> (quiet period) -> analysis -> score
 *   -> supervisor (rules + LLM + rules) -> response generator -> safety -> draft/send
 *   -> CRM update -> follow-up scheduling
 */

const OFFER_ACTIONS = new Set<SalesAction>([
  "RECOMMEND_COURSE",
  "RECOMMEND_KIT",
  "RECOMMEND_COURSE_AND_KIT",
  "OFFER_PAYMENT_PLAN",
  "OFFER_CALL",
  "SEND_ENROLMENT_INFORMATION",
]);

export type ProcessResult =
  | { status: "locked" | "nothing_to_do" | "agent_disabled" | "not_found" | "quiet_period" }
  | { status: "human_takeover"; analysis: LeadAnalysis }
  | { status: "done"; decision: SalesDecision; outcome: string; batchId?: string; analysis: LeadAnalysis; score: ScoreBreakdown }
  | { status: "handoff"; reason: string };

export class LyoraAgent {
  constructor(public readonly ctx: AgentContext) {}

  private now() {
    return this.ctx.clock.now().toISOString();
  }

  // ------------------------------------------------------------------ ingestion
  /** Store webhook events. Returns ids of leads that now need a reply. */
  ingestWebhook(parsed: ParsedWebhook): { leadIds: string[]; duplicates: number } {
    const leadIds = new Set<string>();
    let duplicates = 0;
    for (const e of parsed.echoes) this.ingestEcho(e);
    for (const e of parsed.inbound) {
      const r = this.ingestInbound(e);
      if (r.duplicate) duplicates++;
      else if (r.lead) leadIds.add(r.lead.id);
    }
    return { leadIds: [...leadIds], duplicates };
  }

  ingestInbound(e: InboundEvent): { lead: Lead | null; message: Message | null; duplicate: boolean } {
    const { repos } = this.ctx;
    const now = this.now();
    // Idempotency: never process the same provider message twice.
    if (repos.messages.existsByPlatformId(e.platform, e.platform_message_id)) return { lead: null, message: null, duplicate: true };

    const lead = repos.leads.upsertFromChannel({
      platform: e.platform,
      platform_user_id: e.platform_user_id,
      username: e.username,
      display_name: e.display_name,
      email: e.email,
      source: e.source,
      now,
    });
    const message = repos.messages.insertInbound({
      lead_id: lead.id,
      platform: e.platform,
      platform_message_id: e.platform_message_id,
      content: e.text,
      created_at: e.sent_at,
    });
    if (!message) return { lead, message: null, duplicate: true };

    const fields: Record<string, unknown> = {
      last_inbound_message_at: e.sent_at > (lead.last_inbound_message_at ?? "") ? e.sent_at : lead.last_inbound_message_at,
      needs_processing: true,
      updated_at: now,
    };
    if (lead.status === "new") fields.status = "engaged";
    // A low-priority "manual follow-up suggested" item is moot once she writes back.
    if (lead.handoff_required && !lead.handoff_resolved_at && lead.handoff_priority === "low") fields.handoff_resolved_at = now;
    repos.leads.update(lead.id, fields);

    const cancelled = repos.followUps.cancelAllForLead(lead.id, "lead replied", now);
    // Any unsent draft was written before this message — it's stale now.
    const discarded = repos.outbound.discardPendingForLead(lead.id);
    repos.audit.write({
      lead_id: lead.id,
      stage: "ingest",
      event: "inbound_message",
      data: { messageId: message.id, cancelledFollowUps: cancelled, discardedDrafts: discarded },
      actor: "system",
      now,
    });
    return { lead: repos.leads.get(lead.id), message, duplicate: false };
  }

  /** A message sent from the business account outside this system (Lee typing in the app). */
  ingestEcho(e: EchoEvent) {
    const { repos, cfg } = this.ctx;
    if (repos.messages.existsByPlatformId(e.platform, e.platform_message_id)) return; // our own send, already recorded
    const lead = repos.leads.findByPlatformUser(e.platform, e.platform_user_id);
    if (!lead) return;
    const now = this.now();
    repos.messages.insertOutbound({
      lead_id: lead.id,
      platform: e.platform,
      platform_message_id: e.platform_message_id,
      content: e.text,
      sender_type: "human",
      created_at: e.sent_at,
    });
    repos.leads.update(lead.id, { last_outbound_message_at: e.sent_at, first_response_at: lead.first_response_at ?? e.sent_at, updated_at: now });
    if (cfg.AUTO_TAKEOVER_ON_HUMAN_REPLY && !lead.human_takeover) {
      this.setTakeover(lead.id, true, "lee replied manually in instagram");
    }
  }

  // ------------------------------------------------------------------ processing
  async processLead(leadId: string, opts: { ignoreQuietPeriod?: boolean } = {}): Promise<ProcessResult> {
    const { repos, cfg } = this.ctx;
    const owner = `${this.ctx.workerId}:${newId()}`;
    if (!repos.locks.acquire(leadId, owner, this.ctx.clock.now(), cfg.LOCK_TTL_SECONDS)) return { status: "locked" };
    try {
      return await this.runReply(leadId, opts);
    } catch (err) {
      // Unexpected failure: don't loop on it every tick — hand the conversation to Lee.
      log.error("processLead failed", { leadId, err });
      const now = this.now();
      repos.leads.setHandoff(leadId, "agent error while processing — please reply manually", "high", now);
      repos.messages.markProcessed(repos.messages.unprocessedInbound(leadId).map((m) => m.id), now);
      repos.leads.update(leadId, { needs_processing: false, updated_at: now });
      repos.audit.write({ lead_id: leadId, stage: "pipeline", event: "error", data: { error: String(err) }, actor: "system", now });
      return { status: "handoff", reason: "agent error" };
    } finally {
      repos.locks.release(leadId, owner);
    }
  }

  private async runReply(leadId: string, opts: { ignoreQuietPeriod?: boolean }): Promise<ProcessResult> {
    const { repos, cfg } = this.ctx;
    const lead = repos.leads.get(leadId);
    if (!lead) return { status: "not_found" };
    const pending = repos.messages.unprocessedInbound(lead.id);
    if (!pending.length) {
      repos.leads.update(lead.id, { needs_processing: false });
      return { status: "nothing_to_do" };
    }
    if (!cfg.AGENT_ENABLED) return { status: "agent_disabled" };
    const latestAt = pending[pending.length - 1]!.created_at;
    if (!opts.ignoreQuietPeriod && this.ctx.clock.now().getTime() - new Date(latestAt).getTime() < cfg.INBOUND_QUIET_PERIOD_SECONDS * 1000) {
      return { status: "quiet_period" };
    }

    const runId = newId();
    const now = this.now();
    const conversation = repos.messages.forLead(lead.id);
    const finish = () => {
      repos.messages.markProcessed(pending.map((m) => m.id), this.now());
      repos.leads.update(lead.id, { needs_processing: false, updated_at: this.now() });
    };

    // ---- 1. lead analysis
    const purchases = repos.purchases.forLead(lead.id).filter((p) => p.status === "paid");
    const purchasedProductIds = purchases.map((p) => p.product_id).filter((x): x is string => !!x);
    let analysis: LeadAnalysis;
    try {
      const res = await this.ctx.llm.generateLeadAnalysis({
        conversation,
        previous: lead.analysis,
        purchasedProductNames: purchasedProductIds.map((id) => repos.products.getProductById(id)?.name ?? id),
      });
      analysis = sanitiseAnalysis(res.output);
      repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "analysis", event: "completed", prompt_name: res.promptName, prompt_version: res.promptVersion, model: res.model, data: analysis, now });
    } catch (err) {
      return this.llmFailure(lead, runId, err, finish);
    }

    // ---- 2. deterministic signals + score
    const inboundTexts = conversation.filter((m) => m.direction === "inbound").map((m) => m.content);
    const all = detectSignalsAcross(inboundTexts);
    const recent = detectSignalsAcross(pending.map((m) => m.content));
    const scoringSignals: Signals = { ...all, saidNo: recent.saidNo, askedToStop: recent.askedToStop, readyToBuy: recent.readyToBuy || all.readyToBuy };
    if (recent.askedToStop) analysis.asked_to_stop = true;
    const score = scoreLead(scoringSignals, analysis, inboundTexts.length, {
      hot: cfg.HOT_LEAD_THRESHOLD,
      veryHot: cfg.VERY_HOT_LEAD_THRESHOLD,
    });
    this.saveAnalysis(lead, analysis, score, conversation);
    repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "scoring", event: "scored", data: score, now });

    // ---- 3. human takeover: record everything, send nothing
    const current = repos.leads.get(lead.id)!;
    if (current.human_takeover) {
      repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "supervisor", event: "skipped_human_takeover", now });
      finish();
      return { status: "human_takeover", analysis };
    }

    // ---- 4. sales supervisor
    const products = repos.products.all();
    const stockFor = (sku: string) => repos.stock.get(sku);
    const catalogue = buildCatalogue(products.filter((p) => p.active), stockFor);
    let sup;
    try {
      sup = await decide(
        {
          llm: this.ctx.llm,
          products,
          stockFor,
          confidenceThreshold: cfg.CONFIDENCE_THRESHOLD,
          highTicketThreshold: cfg.HIGH_TICKET_THRESHOLD,
          veryHotThreshold: cfg.VERY_HOT_LEAD_THRESHOLD,
          defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
        },
        {
          trigger: "reply",
          lead: current,
          analysis,
          score: score.final,
          conversation,
          catalogue,
          offersMade: repos.offers.forLead(lead.id),
          purchasedProductIds,
          followUpsSent: repos.followUps.countSentForLead(lead.id),
          callBooked: current.call_booked,
          defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
          recent,
          inboundCount: inboundTexts.length,
        },
      );
    } catch (err) {
      return this.llmFailure(lead, runId, err, finish);
    }
    const decision = sup.decision;
    repos.audit.write({
      lead_id: lead.id,
      run_id: runId,
      stage: "supervisor",
      event: decision.action,
      prompt_name: sup.source === "llm" ? "sales-supervisor" : "rules",
      prompt_version: sup.promptVersion ?? null,
      model: sup.model ?? null,
      data: { decision, source: sup.source, adjustments: sup.adjustments, catalogue: catalogue.map((c) => c.id) },
      now,
    });

    // ---- 5. side effects of the decision
    this.applyDecision(current, decision);

    // ---- 6. compose + safety + draft/send
    let outcome = "no_message";
    let batchId: string | undefined;
    const wantsMessage = decision.should_send_message && (MESSAGE_ACTIONS.has(decision.action) || decision.action === "MARK_NOT_INTERESTED");
    if (wantsMessage) {
      const facts = buildFacts({
        decision,
        analysis,
        products: decision.product_ids.map((id) => products.find((p) => p.id === id)!).filter(Boolean),
        stockFor,
        approvedProof: repos.proof.approved(),
        defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
      });
      let composed;
      try {
        composed = await composeValidated(this.ctx, { leadId: lead.id, runId, trigger: "reply", decision, analysis, conversation, facts });
      } catch (err) {
        return this.llmFailure(lead, runId, err, finish);
      }
      if (!composed.ok) {
        const reason = `safety check failed twice (${composed.issues.filter((i) => i.severity === "block").map((i) => i.type).join(", ")})`;
        repos.leads.setHandoff(lead.id, reason, "normal", this.now());
        repos.followUps.cancelAllForLead(lead.id, "handoff", this.now());
        finish();
        return { status: "handoff", reason };
      }
      const batch = repos.outbound.createBatch({
        lead_id: lead.id,
        messages: composed.messages,
        status: cfg.SEND_MODE === "auto" ? "queued" : "draft",
        trigger: "reply",
        trigger_ref: pending[pending.length - 1]!.id,
        decision_action: decision.action,
        now: this.now(),
      });
      batchId = batch[0]?.batch_id;
      for (const id of decision.product_ids) repos.offers.record(lead.id, id, decision.action, this.now());
      if (batchId && cfg.SEND_MODE === "auto") {
        const sent = await sendBatch(this.ctx, batchId, "agent");
        outcome = sent.status === "sent" ? "sent" : `send_${sent.status}`;
      } else {
        outcome = batchId ? "draft_created" : "duplicate_batch";
        repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "send", event: "draft_created", data: { batchId }, now: this.now() });
      }
    }

    // ---- 7. follow-up scheduling
    const after = repos.leads.get(lead.id)!;
    if ((OFFER_ACTIONS.has(decision.action) || decision.next_follow_up_hours) && after.automation_status === "active" && !after.handoff_required) {
      const lastLead = pending[pending.length - 1]!.content;
      scheduleFollowUp(this.ctx, after, {
        reason: `${decision.action}: ${decision.reason}`,
        context: `she last said: "${lastLead.slice(0, 280)}". we responded with ${decision.action.toLowerCase().replace(/_/g, " ")}${
          decision.product_ids.length ? ` (${decision.product_ids.map((id) => products.find((p) => p.id === id)?.name ?? id).join(", ")})` : ""
        }. ${analysis.main_goal ? `her goal: ${analysis.main_goal}.` : ""} ${analysis.pain_points.length ? `pain points: ${analysis.pain_points.join(", ")}.` : ""}`.trim(),
        hours: decision.next_follow_up_hours,
      });
    }

    finish();
    return { status: "done", decision, outcome, batchId, analysis, score };
  }

  private llmFailure(lead: Lead, runId: string, err: unknown, finish: () => void): ProcessResult {
    if (!(err instanceof LLMUnavailableError)) throw err;
    const now = this.now();
    const reason = err.kind === "refusal" ? "AI declined to handle this conversation" : `AI unavailable (${err.message})`;
    this.ctx.repos.leads.setHandoff(lead.id, reason, err.kind === "refusal" ? "high" : "normal", now);
    this.ctx.repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "pipeline", event: "llm_unavailable", data: { kind: err.kind, message: err.message }, now });
    finish();
    return { status: "handoff", reason };
  }

  private saveAnalysis(lead: Lead, a: LeadAnalysis, score: ScoreBreakdown, conversation: Message[]) {
    const { repos } = this.ctx;
    const now = this.now();
    repos.leads.update(lead.id, {
      lead_temperature: score.temperature,
      lead_score: score.final,
      experience_level: a.experience_level,
      current_job: a.current_job || lead.current_job,
      main_goal: a.main_goal || lead.main_goal,
      pain_points: a.pain_points,
      objections: a.objections,
      budget_concern: a.budget_concern,
      payment_plan_interest: a.payment_plan_interest,
      kit_needed: a.kit_needed,
      kit_interest: a.kit_interest,
      course_interest: a.course_interest,
      coaching_interest: a.coaching_interest,
      call_interest: a.call_interest,
      ai_summary: a.summary,
      analysis_json: a,
      updated_at: now,
    });
    const inbound = conversation.filter((m) => m.direction === "inbound");
    for (const f of a.facts) {
      if (!f.key || !f.value) continue;
      const src = inbound.find((m) => f.source_quote && m.content.toLowerCase().includes(f.source_quote.toLowerCase().slice(0, 40)));
      repos.notes.add({ lead_id: lead.id, key: f.key, value: f.value, confidence: src ? a.confidence : a.confidence * 0.5, source_message_id: src?.id ?? null, now });
    }
  }

  private applyDecision(lead: Lead, d: SalesDecision) {
    const { repos } = this.ctx;
    const now = this.now();
    switch (d.action) {
      case "STOP_AUTOMATION":
        repos.leads.update(lead.id, { automation_status: "stopped", stop_reason: "asked not to be contacted", status: "stopped", follow_up_due_at: null, updated_at: now });
        repos.followUps.cancelAllForLead(lead.id, "stop requested", now);
        repos.outbound.discardPendingForLead(lead.id);
        break;
      case "MARK_NOT_INTERESTED":
        repos.leads.update(lead.id, { automation_status: "stopped", stop_reason: "not interested", status: "not_interested", follow_up_due_at: null, updated_at: now });
        repos.followUps.cancelAllForLead(lead.id, "not interested", now);
        break;
      case "HUMAN_HANDOFF":
      case "MARK_PURCHASED":
        repos.leads.setHandoff(lead.id, d.action === "MARK_PURCHASED" ? "lead says she bought — verify and mark purchased" : d.handoff_reason || d.reason, d.handoff_priority, now);
        repos.followUps.cancelAllForLead(lead.id, "handoff", now);
        break;
      case "RECOMMEND_COURSE":
      case "RECOMMEND_KIT":
      case "RECOMMEND_COURSE_AND_KIT":
      case "OFFER_PAYMENT_PLAN":
      case "SEND_ENROLMENT_INFORMATION":
      case "OFFER_CALL":
        repos.leads.update(lead.id, {
          status: lead.status === "purchased" ? lead.status : "offer_made",
          recommended_offer: d.product_ids[0] ?? lead.recommended_offer,
          updated_at: now,
        });
        break;
      default:
        if (lead.status === "new") repos.leads.update(lead.id, { status: "engaged", updated_at: now });
    }
  }

  // ------------------------------------------------------------------ follow-ups
  async runDueFollowUps(): Promise<{ sent: number; drafted: number; cancelled: number; skipped: number }> {
    const { repos, cfg } = this.ctx;
    const stats = { sent: 0, drafted: 0, cancelled: 0, skipped: 0 };
    for (const fu of repos.followUps.due(this.now())) {
      const owner = `${this.ctx.workerId}:${newId()}`;
      if (!repos.locks.acquire(fu.lead_id, owner, this.ctx.clock.now(), cfg.LOCK_TTL_SECONDS)) continue;
      try {
        const r = await this.runFollowUp(fu.id);
        stats[r]++;
      } catch (err) {
        log.error("follow-up failed", { followUpId: fu.id, err });
        repos.followUps.setStatus(fu.id, "skipped", "error", this.now());
        stats.skipped++;
      } finally {
        repos.locks.release(fu.lead_id, owner);
      }
    }
    return stats;
  }

  private async runFollowUp(followUpId: string): Promise<"sent" | "drafted" | "cancelled" | "skipped"> {
    const { repos, cfg } = this.ctx;
    const fu = repos.followUps.get(followUpId)!;
    if (fu.status !== "scheduled") return "skipped";
    const lead = repos.leads.get(fu.lead_id)!;
    const now = this.now();
    const runId = newId();

    const blocker = followUpBlocker(this.ctx, lead, fu);
    if (blocker) {
      repos.followUps.setStatus(fu.id, blocker.status, blocker.reason, now);
      repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "followup", event: blocker.status, data: { followUpId: fu.id, reason: blocker.reason }, now });
      return blocker.status === "cancelled" ? "cancelled" : "skipped";
    }
    if (outsideMessagingWindow(this.ctx, lead)) {
      repos.followUps.setStatus(fu.id, "skipped", "outside 24h messaging window — suggested to lee as a manual follow-up", now);
      repos.leads.setHandoff(lead.id, `manual follow-up suggested: ${fu.context.slice(0, 200)}`, "low", now);
      return "skipped";
    }
    if (!inSendHours(this.ctx)) {
      const next = nextTimeInWindow(this.ctx.clock.now(), cfg.BUSINESS_TIMEZONE, cfg.FOLLOWUP_SEND_START_HOUR, cfg.FOLLOWUP_SEND_END_HOUR);
      repos.db.prepare("UPDATE follow_ups SET scheduled_at = ?, updated_at = ? WHERE id = ?").run(next.toISOString(), now, fu.id);
      return "skipped";
    }

    const conversation = repos.messages.forLead(lead.id);
    const analysis = lead.analysis;
    if (!analysis) {
      repos.followUps.setStatus(fu.id, "skipped", "no analysis on file", now);
      return "skipped";
    }
    const products = repos.products.all();
    const stockFor = (sku: string) => repos.stock.get(sku);
    const purchasedProductIds = repos.purchases.forLead(lead.id).filter((p) => p.status === "paid").map((p) => p.product_id!).filter(Boolean);
    let sup;
    try {
      sup = await decide(
        {
          llm: this.ctx.llm,
          products,
          stockFor,
          confidenceThreshold: cfg.CONFIDENCE_THRESHOLD,
          highTicketThreshold: cfg.HIGH_TICKET_THRESHOLD,
          veryHotThreshold: cfg.VERY_HOT_LEAD_THRESHOLD,
          defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
        },
        {
          trigger: "followup",
          lead,
          analysis,
          score: lead.lead_score,
          conversation,
          catalogue: buildCatalogue(products.filter((p) => p.active), stockFor),
          offersMade: repos.offers.forLead(lead.id),
          purchasedProductIds,
          followUpsSent: repos.followUps.countSentForLead(lead.id),
          callBooked: lead.call_booked,
          defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
          followUpContext: fu.context,
          recent: detectSignalsAcross([]),
          inboundCount: conversation.filter((m) => m.direction === "inbound").length,
        },
      );
    } catch (err) {
      if (err instanceof LLMUnavailableError) {
        repos.followUps.setStatus(fu.id, "skipped", `AI unavailable: ${err.message}`, now);
        return "skipped";
      }
      throw err;
    }
    const d = sup.decision;
    repos.audit.write({ lead_id: lead.id, run_id: runId, stage: "supervisor", event: `followup_${d.action}`, model: sup.model ?? null, prompt_version: sup.promptVersion ?? null, data: { decision: d, adjustments: sup.adjustments, followUpId: fu.id }, now });

    if (d.action !== "FOLLOW_UP" || !d.should_send_message) {
      this.applyDecision(lead, d);
      repos.followUps.setStatus(fu.id, "skipped", `supervisor chose ${d.action}: ${d.reason}`, now);
      return "skipped";
    }

    const facts = buildFacts({
      decision: d,
      analysis,
      products: d.product_ids.map((id) => products.find((p) => p.id === id)!).filter(Boolean),
      stockFor,
      approvedProof: repos.proof.approved(),
      defaultBookingUrl: cfg.DEFAULT_BOOKING_URL || null,
    });
    const composed = await composeValidated(this.ctx, { leadId: lead.id, runId, trigger: "followup", decision: d, analysis, conversation, facts, followUpContext: fu.context });
    if (!composed.ok) {
      repos.followUps.setStatus(fu.id, "skipped", "safety check failed twice", now);
      repos.leads.setHandoff(lead.id, `follow-up failed safety check — consider a manual follow-up`, "low", now);
      return "skipped";
    }
    const batch = repos.outbound.createBatch({
      lead_id: lead.id,
      messages: composed.messages,
      status: cfg.SEND_MODE === "auto" ? "queued" : "draft",
      trigger: "followup",
      trigger_ref: fu.id,
      decision_action: "FOLLOW_UP",
      now: this.now(),
    });
    const batchId = batch[0]?.batch_id;
    let result: "sent" | "drafted" = "drafted";
    if (batchId && cfg.SEND_MODE === "auto") {
      const sent = await sendBatch(this.ctx, batchId, "agent");
      if (sent.status !== "sent") {
        repos.followUps.setStatus(fu.id, "skipped", `send ${sent.status}`, this.now());
        return "skipped";
      }
      repos.followUps.setStatus(fu.id, "sent", null, this.now());
      result = "sent";
    } else {
      repos.followUps.setStatus(fu.id, "completed", "draft created for review", this.now());
    }
    const count = repos.followUps.countSentForLead(lead.id);
    repos.leads.update(lead.id, { follow_up_count: count, follow_up_due_at: null, updated_at: this.now() });
    if (count < cfg.MAX_AUTOMATED_FOLLOWUPS) {
      scheduleFollowUp(this.ctx, repos.leads.get(lead.id)!, { reason: `follow-up ${count + 1}`, context: fu.context });
    }
    return result;
  }

  // ------------------------------------------------------------------ periodic safety check
  /** Runs every MESSAGE_CHECK_INTERVAL_MINUTES (and on demand). */
  async tick(): Promise<Record<string, number>> {
    const { repos, cfg } = this.ctx;
    const summary: Record<string, number> = { processed: 0, followUpsSent: 0, followUpsDrafted: 0, retried: 0, openHandoffs: 0 };
    const quietBefore = new Date(this.ctx.clock.now().getTime() - cfg.INBOUND_QUIET_PERIOD_SECONDS * 1000).toISOString();
    for (const lead of repos.leads.needingProcessing(quietBefore)) {
      const r = await this.processLead(lead.id);
      if (r.status === "done" || r.status === "handoff" || r.status === "human_takeover") summary.processed!++;
    }
    const fu = await this.runDueFollowUps();
    summary.followUpsSent = fu.sent;
    summary.followUpsDrafted = fu.drafted;
    if (cfg.SEND_MODE === "auto") {
      const batches = new Set(repos.outbound.byStatus("failed").filter((o) => o.attempts < 3).map((o) => o.batch_id));
      for (const b of batches) {
        const r = await sendBatch(this.ctx, b, "agent");
        if (r.status === "sent") summary.retried!++;
      }
    }
    summary.openHandoffs = repos.leads.unresolvedHandoffs().length;
    log.info("tick", summary);
    return summary;
  }

  // ------------------------------------------------------------------ human controls
  setTakeover(leadId: string, on: boolean, reason: string) {
    const { repos } = this.ctx;
    const now = this.now();
    repos.leads.update(leadId, { human_takeover: on, human_takeover_at: on ? now : null, updated_at: now });
    if (on) {
      repos.followUps.cancelAllForLead(leadId, "human takeover", now);
      repos.outbound.discardPendingForLead(leadId);
    } else {
      // Resuming: messages that arrived while Lee was handling it are considered handled.
      repos.messages.markProcessed(repos.messages.unprocessedInbound(leadId).map((m) => m.id), now);
      repos.leads.update(leadId, { needs_processing: false });
    }
    repos.audit.write({ lead_id: leadId, stage: "admin", event: on ? "human_takeover_on" : "human_takeover_off", data: { reason }, actor: "human", now });
  }
}

function sanitiseAnalysis(a: LeadAnalysis): LeadAnalysis {
  return {
    ...a,
    pain_points: [...new Set(a.pain_points ?? [])].slice(0, 10),
    objections: [...new Set(a.objections ?? [])].slice(0, 10),
    facts: (a.facts ?? []).slice(0, 20),
    open_questions: (a.open_questions ?? []).slice(0, 10),
    ai_score: clamp(a.ai_score, 0, 100),
    confidence: clamp(a.confidence, 0, 1),
  };
}
