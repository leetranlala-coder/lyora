import type { LeadAnalysis, ResponseDraft, SafetyVerdict, SalesDecision } from "../domain/types.js";
import { detectSignalsAcross } from "../agents/signals.js";
import type {
  AnalysisInput,
  CatalogueEntry,
  Fact,
  LLMProvider,
  LLMResult,
  ResponseInput,
  SupervisorInput,
  ValidateInput,
} from "./provider.js";

/**
 * Deterministic, offline stand-in for the LLM. Used for local development without an API key
 * and for the test suite. It is intentionally simple: it exists so the whole pipeline
 * (guardrails, CRM, follow-ups, idempotency, safety) can be exercised end to end.
 * Real conversation quality comes from the Anthropic provider.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  /** Optional overrides so tests can force specific model outputs. */
  constructor(
    private overrides: {
      analysis?: Partial<LeadAnalysis>;
      decision?: Partial<SalesDecision>;
      response?: ResponseDraft | ((i: ResponseInput, attempt: number) => ResponseDraft);
      verdict?: SafetyVerdict;
    } = {},
  ) {}
  private responseCalls = 0;

  private wrap<T>(output: T, promptName: string): LLMResult<T> {
    return { output, model: "mock", promptName, promptVersion: "mock" };
  }

  async generateLeadAnalysis(input: AnalysisInput): Promise<LLMResult<LeadAnalysis>> {
    const inbound = input.conversation.filter((m) => m.direction === "inbound").map((m) => m.content);
    // "current position": messages since lee last spoke
    const lastOut = input.conversation.map((m) => m.direction).lastIndexOf("outbound");
    const current = input.conversation.slice(lastOut + 1).filter((m) => m.direction === "inbound").map((m) => m.content);
    const all = detectSignalsAcross(inbound);
    const now = detectSignalsAcross(current);

    const experience = all.nailTech ? "nail_tech" : all.beginner ? "beginner" : "unknown";
    const owns = all.hasProducts ? "full_setup" : all.noProducts ? "none" : "unknown";
    const money: LeadAnalysis["money_objection_type"] = all.cannotAfford
      ? "cannot_afford"
      : all.paymentPlanAsk
        ? "needs_instalments"
        : all.wantsCheaper
          ? "wants_cheaper_entry"
          : all.unsureValue
            ? "unsure_of_value"
            : all.priceAsk
              ? "needs_more_info"
              : "none";
    let score = 10 + Math.min(inbound.length, 5) * 3;
    if (all.sharedGoal || all.painPoints.length) score = Math.max(score, 35);
    if (all.priceAsk || all.paymentPlanAsk || all.kitAsk || all.includedAsk) score = Math.max(score, 58);
    if (now.readyToBuy || now.wantsCall) score = Math.max(score, 85);

    const sensitive: LeadAnalysis["sensitive_topic"] = now.dispute
      ? "payment_dispute"
      : now.refund
        ? "refund"
        : now.complaint
          ? "complaint"
          : now.medical
            ? "medical"
            : now.legal
              ? "legal"
              : now.tax
                ? "tax"
                : "none";

    const analysis: LeadAnalysis = {
      lead_temperature: score >= 76 ? "very_hot" : score >= 51 ? "hot" : score >= 26 ? "warm" : "cold",
      experience_level: experience,
      current_job: "",
      life_context: all.lifeContext.join(", "),
      main_goal: all.goals.join(", "),
      pain_points: all.painPoints,
      objections: money !== "none" && money !== "needs_more_info" ? [money.replace(/_/g, " ")] : [],
      money_objection_type: money,
      budget_concern: all.cannotAfford || all.unsureValue || all.wantsCheaper,
      payment_plan_interest: all.paymentPlanAsk,
      owns_products: owns,
      kit_needed: experience !== "nail_tech" && owns === "none" && !all.declinesKit,
      kit_interest: all.kitAsk && !all.declinesKit,
      kit_declined: all.declinesKit,
      course_interest: true,
      coaching_interest: false,
      call_interest: all.wantsCall,
      asked_to_speak_to_lee: now.wantsLee,
      purchase_intent: now.claimsPurchased ? "purchased" : now.readyToBuy ? "ready_to_buy" : all.priceAsk ? "considering" : "browsing",
      said_no: now.saidNo,
      asked_to_stop: now.askedToStop,
      sentiment: now.angry ? "angry" : "neutral",
      sensitive_topic: sensitive,
      open_questions: current.filter((t) => t.includes("?")),
      facts: [
        ...all.lifeContext.map((v) => ({ key: "life_context", value: v, source_quote: findQuote(inbound, v) })),
        ...all.goals.map((v) => ({ key: "goal", value: v, source_quote: findQuote(inbound, v) })),
      ],
      summary: `${experience} lead. ${all.painPoints.length ? "struggles with " + all.painPoints.join(", ") + ". " : ""}${all.goals.length ? "goal: " + all.goals.join(", ") : ""}`.trim(),
      recommended_next_action: "",
      human_handoff: false,
      handoff_reason: "",
      ai_score: score,
      confidence: inbound.length ? 0.8 : 0.3,
      ...this.overrides.analysis,
    };
    return this.wrap(analysis, "lead-analysis");
  }

  async generateSalesDecision(input: SupervisorInput): Promise<LLMResult<SalesDecision>> {
    const d = { ...policy(input), ...this.overrides.decision };
    return this.wrap(d, "sales-supervisor");
  }

  async generateResponse(input: ResponseInput): Promise<LLMResult<ResponseDraft>> {
    this.responseCalls++;
    const o = this.overrides.response;
    if (o) return this.wrap(typeof o === "function" ? o(input, this.responseCalls) : o, "response-generator");
    return this.wrap(template(input), "response-generator");
  }

  async validateResponse(_input: ValidateInput): Promise<LLMResult<SafetyVerdict>> {
    return this.wrap(this.overrides.verdict ?? { approved: true, issues: [] }, "safety-validator");
  }
}

function findQuote(texts: string[], label: string): string {
  const word = label.split(/\W+/)[0] ?? "";
  return texts.find((t) => t.toLowerCase().includes(word.toLowerCase())) ?? texts[texts.length - 1] ?? "";
}

// --------------------------------------------------------------- policy
function pick(cat: CatalogueEntry[], type: string): CatalogueEntry | undefined {
  return cat.filter((c) => c.type === type).sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
}

function base(action: SalesDecision["action"], reason: string, extra: Partial<SalesDecision> = {}): SalesDecision {
  return {
    action,
    reason,
    urgency: "normal",
    should_send_message: true,
    product_ids: [],
    question_focus: "",
    talking_points: [],
    next_follow_up_hours: null,
    handoff_reason: "",
    handoff_priority: "normal",
    confidence: 0.85,
    ...extra,
  };
}

function policy(i: SupervisorInput): SalesDecision {
  const a = i.analysis;
  const latest = i.conversation.filter((m) => m.direction === "inbound").slice(-3).map((m) => m.content);
  const s = detectSignalsAcross(latest);
  const course = pick(i.catalogue.filter((c) => !i.purchasedProductIds.includes(c.id)), "course");
  const bundle = pick(i.catalogue.filter((c) => !i.purchasedProductIds.includes(c.id)), "course_and_kit");
  const kit = pick(i.catalogue, "kit");
  const wantsKit = (a.kit_needed || a.kit_interest) && !a.kit_declined && a.owns_products !== "full_setup";
  const main = wantsKit ? (bundle ?? course) : course;

  if (i.trigger === "followup") {
    return base("FOLLOW_UP", "gentle follow-up on an open conversation", {
      talking_points: [i.followUpContext ?? "check in on what she was considering"],
      product_ids: main ? [main.id] : [],
    });
  }
  if (s.wantsCall || a.call_interest) {
    return base("OFFER_CALL", "lead wants to talk", { product_ids: main ? [main.id] : [], urgency: "high" });
  }
  if (s.readyToBuy || a.purchase_intent === "ready_to_buy") {
    if (!main) return base("HUMAN_HANDOFF", "ready to buy but no product", { should_send_message: false });
    if (a.payment_plan_interest && main.payment_plan_available) {
      return base("OFFER_PAYMENT_PLAN", "ready to buy and asked about instalments", { product_ids: [main.id] });
    }
    return base("SEND_ENROLMENT_INFORMATION", "explicit intent to buy", { product_ids: [main.id], urgency: "high" });
  }
  if (a.money_objection_type === "cannot_afford") {
    return base("NURTURE", "genuine affordability concern — don't push", {
      talking_points: ["acknowledge kindly", "no pressure, right time matters"],
    });
  }
  if (a.money_objection_type === "needs_instalments" || s.paymentPlanAsk) {
    return base("OFFER_PAYMENT_PLAN", "asked about payment plans", { product_ids: main ? [main.id] : [] });
  }
  if (a.money_objection_type === "unsure_of_value" || a.money_objection_type === "wants_cheaper_entry") {
    return base("ANSWER_QUESTION", "address value with what's included", { product_ids: main ? [main.id] : [] });
  }
  if (s.priceAsk || s.includedAsk) {
    return base("ANSWER_QUESTION", "answer price / inclusions", { product_ids: main ? [main.id] : [] });
  }
  if (s.kitAsk && wantsKit) {
    if (bundle) return base("RECOMMEND_COURSE_AND_KIT", "beginner asking about products", { product_ids: [bundle.id] });
    if (kit) return base("RECOMMEND_KIT", "beginner asking about products", { product_ids: [kit.id] });
  }
  if (a.experience_level === "unknown") {
    return base("ASK_QUALIFYING_QUESTION", "need to know experience level", {
      question_focus: "is she already doing nails or starting from scratch",
    });
  }
  if (!a.main_goal && a.pain_points.length === 0) {
    return base("ASK_QUALIFYING_QUESTION", "need to know her goal", { question_focus: "what she'd love nails to do for her" });
  }
  if (a.experience_level === "beginner" && a.owns_products === "unknown") {
    return base("ASK_QUALIFYING_QUESTION", "need to know if she has products", {
      question_focus: "whether she already has any products at home",
    });
  }
  if (wantsKit && bundle) {
    return base("RECOMMEND_COURSE_AND_KIT", "beginner with no products", { product_ids: [bundle.id], next_follow_up_hours: 20 });
  }
  if (course) return base("RECOMMEND_COURSE", "understands her situation; course fits", { product_ids: [course.id], next_follow_up_hours: 20 });
  return base("NURTURE", "nothing to offer yet");
}

// ------------------------------------------------------------- templates
function factOf(facts: Fact[], type: Fact["type"]): Fact | undefined {
  return facts.find((f) => f.type === type);
}

function template(i: ResponseInput): ResponseDraft {
  const f = i.facts;
  const used: string[] = [];
  const use = (fact: Fact | undefined) => {
    if (fact) used.push(fact.id);
    return fact;
  };
  const productName = use(factOf(f, "product"))?.text.replace(/\s*\(.*\)$/, "") ?? "the course";
  const price = use(factOf(f, "price"));
  const plan = use(factOf(f, "payment_plan"));
  const link = use(factOf(f, "checkout_link"));
  const planLink = use(factOf(f, "payment_plan_link"));
  const booking = use(factOf(f, "booking_link"));
  const priceText = price?.text.match(/\$[\d,.]+ \w+/)?.[0];
  const planText = plan?.text.split(": ").slice(1).join(": ");
  const urlOf = (fact?: Fact) => fact?.text.match(/https?:\/\/\S+/)?.[0];
  const pain = i.analysis.pain_points[0];

  let messages: string[];
  switch (i.decision.action) {
    case "ASK_QUALIFYING_QUESTION":
      messages = [
        "hi lovely, thank you for reaching out xx",
        i.decision.question_focus.includes("products")
          ? "have you already got any products at home or would you be starting from zero?"
          : i.decision.question_focus.includes("goal") || i.decision.question_focus.includes("hoping")
            ? "what would you love nails to do for you? like a bit of extra income on the side, or something bigger?"
            : "are you already doing nails or would you be starting completely from scratch?",
      ];
      break;
    case "ANSWER_QUESTION":
      messages = [
        pain ? `honestly ${pain} is sooo common, and it's exactly what i help with` : "of course babe",
        priceText ? `${productName} is ${priceText}${planText ? `, or ${planText}` : ""}` : `${productName} is what i'd point you towards`,
        "is there anything specific you're hoping to get better at?",
      ];
      break;
    case "RECOMMEND_COURSE":
    case "RECOMMEND_KIT":
    case "RECOMMEND_COURSE_AND_KIT":
      messages = [
        "okay that makes so much sense",
        `honestly i think ${productName} would suit you best${i.decision.action !== "RECOMMEND_COURSE" ? " so you've got the right essentials and you're not wasting money on random products" : ""}`,
        "want me to send you through the details?",
      ];
      break;
    case "OFFER_PAYMENT_PLAN":
      messages = planText
        ? [`yes babe there's a payment plan for ${productName}: ${planText}`, ...(urlOf(planLink ?? link) ? [`here's the link whenever you're ready ${urlOf(planLink ?? link)}`] : [])]
        : ["let me check the payment options for you"];
      break;
    case "SEND_ENROLMENT_INFORMATION":
      messages = [`yay i'm so excited for you 🤍`, `here's the link for ${productName}: ${urlOf(link) ?? ""}`.trim(), "message me if anything doesn't work xx"];
      break;
    case "OFFER_CALL":
      messages = [`of course, i'd love to chat`, `you can grab a time that suits you here ${urlOf(booking) ?? ""}`.trim()];
      break;
    case "NURTURE":
      messages = [
        "no babe i completely understand, i wouldn't want you putting yourself in a bad position for it either xx",
        "there's honestly no rush, start when it feels right for you 🤍",
      ];
      break;
    case "FOLLOW_UP":
      messages = [`hey lovely, i was thinking about what you said${pain ? ` about ${pain}` : ""}. did you have any questions about it? xx`];
      break;
    case "MARK_NOT_INTERESTED":
      messages = ["no worries at all lovely, thank you for letting me know 🤍", "if you ever want a hand with anything nails, i'm here xx"];
      break;
    default:
      messages = ["thank you lovely xx"];
  }
  return { messages, claims_used: used };
}
