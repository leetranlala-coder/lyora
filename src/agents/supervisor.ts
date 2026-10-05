import type { LeadAnalysis, Lead, Product, SalesAction, SalesDecision, StockItem } from "../domain/types.js";
import type { LLMProvider, SupervisorInput } from "../llm/provider.js";
import { isSellable, stockAllowsSale } from "./facts.js";
import { sensitiveHandoff, type Signals } from "./signals.js";

/**
 * Sales supervisor = deterministic guardrails around an LLM decision.
 *
 *   pre-rules  -> hard stops/handoffs that never reach the model (stop requests, refunds, ...)
 *   LLM        -> decides the best next action given everything we know
 *   post-rules -> enforce the catalogue (active products, real prices, payment plans, links,
 *                 stock), purchases, confidence and high-ticket handoff rules
 */

export interface SupervisorDeps {
  llm: LLMProvider;
  products: Product[]; // all products (active + inactive)
  stockFor: (sku: string) => StockItem | null;
  confidenceThreshold: number;
  highTicketThreshold: number;
  veryHotThreshold: number;
  defaultBookingUrl: string | null;
}

export interface SupervisorResult {
  decision: SalesDecision;
  source: "rule" | "llm";
  adjustments: string[];
  model?: string;
  promptVersion?: string;
}

const PRODUCT_ACTIONS = new Set<SalesAction>([
  "RECOMMEND_COURSE",
  "RECOMMEND_KIT",
  "RECOMMEND_COURSE_AND_KIT",
  "OFFER_PAYMENT_PLAN",
  "SEND_ENROLMENT_INFORMATION",
]);

export function ruleDecision(
  action: SalesAction,
  reason: string,
  extra: Partial<SalesDecision> = {},
): SalesDecision {
  return {
    action,
    reason,
    urgency: "normal",
    should_send_message: false,
    product_ids: [],
    question_focus: "",
    talking_points: [],
    next_follow_up_hours: null,
    handoff_reason: action === "HUMAN_HANDOFF" ? reason : "",
    handoff_priority: "normal",
    confidence: 1,
    ...extra,
  };
}

/** Rules evaluated before calling the model. Returns a decision to short-circuit, or null. */
export function preRules(input: {
  lead: Lead;
  analysis: LeadAnalysis;
  recent: Signals;
  inboundCount: number;
  confidenceThreshold: number;
  trigger: "reply" | "followup";
}): SalesDecision | null {
  const { lead, analysis, recent } = input;

  if (lead.human_takeover) return ruleDecision("WAIT", "human takeover is on — the AI must not send anything");

  // A stop request in the NEW messages always wins.
  if (recent.askedToStop) return ruleDecision("STOP_AUTOMATION", "lead asked not to be contacted");

  const sensitive =
    sensitiveHandoff(recent) ??
    (analysis.sensitive_topic !== "none"
      ? { reason: `sensitive topic: ${analysis.sensitive_topic}`, priority: analysis.sensitive_topic === "refund" || analysis.sensitive_topic === "payment_dispute" ? ("urgent" as const) : ("high" as const) }
      : null) ??
    (analysis.sentiment === "angry" ? { reason: "lead is upset/angry", priority: "urgent" as const } : null) ??
    (analysis.asked_to_speak_to_lee ? { reason: "asked to speak to lee directly", priority: "high" as const } : null);
  if (sensitive) {
    return ruleDecision("HUMAN_HANDOFF", sensitive.reason, { handoff_priority: sensitive.priority, urgency: "high" });
  }

  if (lead.handoff_required && !lead.handoff_resolved_at) {
    return ruleDecision("WAIT", `handoff open (${lead.handoff_reason ?? "needs lee"}) — waiting for lee`);
  }

  if (lead.automation_status === "stopped") {
    // She messaged again after we stopped (said no, bought, booked a call...). A person should answer.
    return ruleDecision("HUMAN_HANDOFF", `lead messaged again after automation stopped (${lead.stop_reason ?? "stopped"})`, {
      handoff_priority: lead.purchased ? "normal" : "high",
    });
  }

  if (analysis.asked_to_stop) return ruleDecision("STOP_AUTOMATION", "lead asked not to be contacted");

  if ((recent.claimsPurchased || analysis.purchase_intent === "purchased") && !lead.purchased) {
    return ruleDecision("HUMAN_HANDOFF", "lead says she has paid — verify payment and mark purchased", { handoff_priority: "high" });
  }

  if (recent.saidNo || analysis.said_no) {
    return ruleDecision("MARK_NOT_INTERESTED", "lead declined", {
      should_send_message: input.trigger === "reply",
      talking_points: ["thank her warmly", "no pressure, door is open if she ever wants help"],
    });
  }

  if (analysis.human_handoff && analysis.handoff_reason) {
    return ruleDecision("HUMAN_HANDOFF", analysis.handoff_reason, { handoff_priority: "normal" });
  }

  if (analysis.confidence < input.confidenceThreshold) {
    if (input.inboundCount >= 3) {
      return ruleDecision("HUMAN_HANDOFF", `analysis confidence ${analysis.confidence.toFixed(2)} below threshold`, {
        handoff_priority: "normal",
      });
    }
    return ruleDecision("ASK_QUALIFYING_QUESTION", "not enough information yet — ask one natural question", {
      should_send_message: true,
      question_focus: "what she's hoping to do with nails and where she's at right now",
      confidence: analysis.confidence,
    });
  }

  return null;
}

/** Rules applied to the model's decision. Returns the corrected decision and what was changed. */
export function postRules(
  d: SalesDecision,
  ctx: {
    lead: Lead;
    analysis: LeadAnalysis;
    score: number;
    products: Product[];
    stockFor: (sku: string) => StockItem | null;
    purchasedProductIds: string[];
    confidenceThreshold: number;
    highTicketThreshold: number;
    veryHotThreshold: number;
    defaultBookingUrl: string | null;
    trigger: "reply" | "followup";
  },
): { decision: SalesDecision; adjustments: string[] } {
  const adj: string[] = [];
  let out: SalesDecision = { ...d, product_ids: [...d.product_ids] };
  const byId = new Map(ctx.products.map((p) => [p.id, p]));
  const handoff = (reason: string, priority: SalesDecision["handoff_priority"] = "normal") => {
    adj.push(`-> HUMAN_HANDOFF: ${reason}`);
    return ruleDecision("HUMAN_HANDOFF", reason, { handoff_priority: priority });
  };

  // 1. confidence
  if (out.confidence < ctx.confidenceThreshold && out.action !== "WAIT" && out.action !== "HUMAN_HANDOFF") {
    return { decision: handoff(`supervisor confidence ${out.confidence.toFixed(2)} below threshold`), adjustments: adj };
  }

  // 2. follow-ups may only follow up, wait or stop
  if (ctx.trigger === "followup" && !["FOLLOW_UP", "WAIT", "STOP_AUTOMATION", "HUMAN_HANDOFF", "MARK_NOT_INTERESTED"].includes(out.action)) {
    adj.push(`follow-up trigger: ${out.action} -> FOLLOW_UP`);
    out.action = "FOLLOW_UP";
    out.should_send_message = true;
  }

  // 3. product references must be real, active, priced products
  const unknownIds = out.product_ids.filter((id) => !byId.has(id));
  if (unknownIds.length) {
    adj.push(`dropped unknown product ids: ${unknownIds.join(", ")}`);
    out.product_ids = out.product_ids.filter((id) => byId.has(id));
  }
  const unpriced = out.product_ids.map((id) => byId.get(id)!).filter((p) => !isSellable(p));
  if (unpriced.length) {
    return {
      decision: handoff(`pricing unknown or product inactive: ${unpriced.map((p) => p.name).join(", ")}`),
      adjustments: adj,
    };
  }

  // 4. never re-sell what she already bought
  const already = out.product_ids.filter((id) => ctx.purchasedProductIds.includes(id));
  if (already.length) {
    adj.push(`removed already-purchased products: ${already.join(", ")}`);
    out.product_ids = out.product_ids.filter((id) => !ctx.purchasedProductIds.includes(id));
    if (PRODUCT_ACTIONS.has(out.action) && out.product_ids.length === 0) {
      adj.push(`${out.action} -> NURTURE (only referenced purchased products)`);
      out = { ...out, action: "NURTURE" };
    }
  }

  // 5. kits only when appropriate and stock allows
  const isKit = (p: Product) => p.type === "kit" || p.type === "course_and_kit";
  const kitProducts = out.product_ids.map((id) => byId.get(id)!).filter(isKit);
  const kitDeclined = ctx.analysis.kit_declined || ctx.analysis.owns_products === "full_setup";
  if (kitProducts.length && kitDeclined) {
    adj.push("removed kit: lead declined a kit or already has a full setup");
    out.product_ids = out.product_ids.filter((id) => !isKit(byId.get(id)!));
    out = switchToCourse(out, ctx.products, ctx.purchasedProductIds, adj);
  }
  const outOfStock = out.product_ids.map((id) => byId.get(id)!).filter((p) => !stockAllowsSale(p, p.sku ? ctx.stockFor(p.sku) : null));
  if (outOfStock.length) {
    if (ctx.analysis.kit_interest || ctx.analysis.purchase_intent === "ready_to_buy") {
      return { decision: handoff(`lead wants ${outOfStock.map((p) => p.name).join(", ")} but it is out of stock`), adjustments: adj };
    }
    adj.push(`removed out-of-stock products: ${outOfStock.map((p) => p.name).join(", ")}`);
    out.product_ids = out.product_ids.filter((id) => !outOfStock.some((p) => p.id === id));
    out = switchToCourse(out, ctx.products, ctx.purchasedProductIds, adj);
  }

  // 6. action-specific requirements
  const refs = out.product_ids.map((id) => byId.get(id)!);
  if (PRODUCT_ACTIONS.has(out.action) && refs.length === 0) {
    return { decision: handoff(`${out.action} chosen but no sellable product with a known price is available`), adjustments: adj };
  }
  if (out.action === "OFFER_PAYMENT_PLAN" && !refs.some((p) => p.payment_plan_available && p.payment_plan_description)) {
    return { decision: handoff("lead wants a payment plan but none is configured for this product"), adjustments: adj };
  }
  if (out.action === "SEND_ENROLMENT_INFORMATION" && !refs.some((p) => p.checkout_url)) {
    return { decision: handoff("lead is ready to enrol but no checkout link is configured", "high"), adjustments: adj };
  }
  if (out.action === "OFFER_CALL") {
    if (ctx.lead.call_booked) {
      adj.push("call already booked -> WAIT");
      out = { ...out, action: "WAIT", should_send_message: false };
    } else if (!refs.some((p) => p.booking_url) && !ctx.defaultBookingUrl) {
      return { decision: handoff("lead wants a call but no booking link is configured", "high"), adjustments: adj };
    }
  }

  // 7. compassion rule: genuine affordability problems are never pushed toward checkout
  if (
    ctx.analysis.money_objection_type === "cannot_afford" &&
    ctx.analysis.purchase_intent !== "ready_to_buy" &&
    (out.action === "SEND_ENROLMENT_INFORMATION" || out.action === "RECOMMEND_COURSE_AND_KIT")
  ) {
    adj.push(`${out.action} -> NURTURE (lead said she can't afford it right now)`);
    out = { ...out, action: "NURTURE", product_ids: [] };
  }

  // 8. very hot + high ticket -> Lee personally
  const maxPrice = Math.max(0, ...refs.map((p) => p.price ?? 0));
  const highTicketType = refs.some((p) => ["coaching", "mentorship", "training"].includes(p.type));
  if (ctx.score >= ctx.veryHotThreshold && (maxPrice >= ctx.highTicketThreshold || highTicketType) && PRODUCT_ACTIONS.has(out.action)) {
    return { decision: handoff(`very hot lead on a high-ticket offer (${refs.map((p) => p.name).join(", ")})`, "high"), adjustments: adj };
  }

  // 9. consistency
  if (out.action === "WAIT" || out.action === "STOP_AUTOMATION" || out.action === "HUMAN_HANDOFF" || out.action === "MARK_PURCHASED") {
    out.should_send_message = false;
  }
  if (out.action === "HUMAN_HANDOFF" && !out.handoff_reason) out.handoff_reason = out.reason;

  return { decision: out, adjustments: adj };
}

function switchToCourse(d: SalesDecision, products: Product[], purchased: string[], adj: string[]): SalesDecision {
  if (!["RECOMMEND_KIT", "RECOMMEND_COURSE_AND_KIT"].includes(d.action)) return d;
  if (d.product_ids.length) return { ...d, action: "RECOMMEND_COURSE" };
  const course = products.find((p) => p.type === "course" && isSellable(p) && !purchased.includes(p.id));
  if (course) {
    adj.push(`${d.action} -> RECOMMEND_COURSE (${course.name})`);
    return { ...d, action: "RECOMMEND_COURSE", product_ids: [course.id] };
  }
  adj.push(`${d.action} -> ASK_QUALIFYING_QUESTION (no suitable course)`);
  return { ...d, action: "ASK_QUALIFYING_QUESTION", product_ids: [] };
}

export async function decide(
  deps: SupervisorDeps,
  input: SupervisorInput & { recent: Signals; inboundCount: number },
): Promise<SupervisorResult> {
  const pre = preRules({
    lead: input.lead,
    analysis: input.analysis,
    recent: input.recent,
    inboundCount: input.inboundCount,
    confidenceThreshold: deps.confidenceThreshold,
    trigger: input.trigger,
  });
  if (pre) return { decision: pre, source: "rule", adjustments: [] };

  const res = await deps.llm.generateSalesDecision(input);
  const { decision, adjustments } = postRules(normaliseDecision(res.output), {
    lead: input.lead,
    analysis: input.analysis,
    score: input.score,
    products: deps.products,
    stockFor: deps.stockFor,
    purchasedProductIds: input.purchasedProductIds,
    confidenceThreshold: deps.confidenceThreshold,
    highTicketThreshold: deps.highTicketThreshold,
    veryHotThreshold: deps.veryHotThreshold,
    defaultBookingUrl: deps.defaultBookingUrl,
    trigger: input.trigger,
  });
  return { decision, source: "llm", adjustments, model: res.model, promptVersion: res.promptVersion };
}

function normaliseDecision(d: SalesDecision): SalesDecision {
  return {
    ...d,
    confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)),
    next_follow_up_hours: d.next_follow_up_hours && d.next_follow_up_hours > 0 ? d.next_follow_up_hours : null,
    product_ids: [...new Set(d.product_ids)],
  };
}
