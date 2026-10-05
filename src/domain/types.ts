import { z } from "zod";

// ------------------------------------------------------------------ enums
export const LeadTemperature = z.enum(["cold", "warm", "hot", "very_hot"]);
export type LeadTemperature = z.infer<typeof LeadTemperature>;

export const ExperienceLevel = z.enum(["beginner", "nail_tech", "unknown"]);

export const MoneyObjectionType = z.enum([
  "none",
  "cannot_afford", // A: genuinely cannot afford it right now
  "unsure_of_value", // B: has money, unsure it's worth it
  "needs_instalments", // C: would buy with a payment plan
  "wants_cheaper_entry", // D: wants a smaller first step
  "needs_more_info", // E: price question is really an information question
]);
export type MoneyObjectionType = z.infer<typeof MoneyObjectionType>;

export const SalesAction = z.enum([
  "ASK_QUALIFYING_QUESTION",
  "ANSWER_QUESTION",
  "NURTURE",
  "RECOMMEND_COURSE",
  "RECOMMEND_KIT",
  "RECOMMEND_COURSE_AND_KIT",
  "OFFER_PAYMENT_PLAN",
  "OFFER_CALL",
  "SEND_ENROLMENT_INFORMATION",
  "FOLLOW_UP",
  "WAIT",
  "STOP_AUTOMATION",
  "HUMAN_HANDOFF",
  "MARK_PURCHASED",
  "MARK_NOT_INTERESTED",
]);
export type SalesAction = z.infer<typeof SalesAction>;

/** Actions that produce a message to the lead. */
export const MESSAGE_ACTIONS: ReadonlySet<SalesAction> = new Set<SalesAction>([
  "ASK_QUALIFYING_QUESTION",
  "ANSWER_QUESTION",
  "NURTURE",
  "RECOMMEND_COURSE",
  "RECOMMEND_KIT",
  "RECOMMEND_COURSE_AND_KIT",
  "OFFER_PAYMENT_PLAN",
  "OFFER_CALL",
  "SEND_ENROLMENT_INFORMATION",
  "FOLLOW_UP",
]);

export const HandoffPriority = z.enum(["low", "normal", "high", "urgent"]);
export type HandoffPriority = z.infer<typeof HandoffPriority>;

// ------------------------------------------------------------- agent 1
/**
 * LLM-facing schema. Kept free of numeric range constraints so it works with
 * structured outputs; ranges are clamped in code after parsing.
 */
export const LeadAnalysisSchema = z.object({
  lead_temperature: LeadTemperature,
  experience_level: ExperienceLevel,
  current_job: z.string(),
  life_context: z.string().describe("e.g. stay-at-home mum, student, full-time job, single mum — only if the lead said so"),
  main_goal: z.string(),
  pain_points: z.array(z.string()),
  objections: z.array(z.string()),
  money_objection_type: MoneyObjectionType,
  budget_concern: z.boolean(),
  payment_plan_interest: z.boolean(),
  owns_products: z.enum(["none", "some", "full_setup", "unknown"]),
  kit_needed: z.boolean(),
  kit_interest: z.boolean(),
  kit_declined: z.boolean().describe("lead explicitly said they do not want a kit"),
  course_interest: z.boolean(),
  coaching_interest: z.boolean(),
  call_interest: z.boolean(),
  asked_to_speak_to_lee: z.boolean(),
  purchase_intent: z.enum(["none", "browsing", "considering", "ready_to_buy", "purchased"]),
  said_no: z.boolean().describe("lead has clearly declined / is not interested"),
  asked_to_stop: z.boolean().describe("lead asked not to be messaged / contacted"),
  sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
  sensitive_topic: z.enum(["none", "complaint", "refund", "payment_dispute", "medical", "legal", "tax", "distress", "other"]),
  open_questions: z.array(z.string()).describe("questions the lead asked that are not answered yet"),
  facts: z
    .array(z.object({ key: z.string(), value: z.string(), source_quote: z.string() }))
    .describe("facts the lead stated about themselves, each with the exact quote it came from"),
  summary: z.string(),
  recommended_next_action: z.string(),
  human_handoff: z.boolean(),
  handoff_reason: z.string(),
  ai_score: z.number().describe("0-100 buying-readiness estimate"),
  confidence: z.number().describe("0-1 how confident you are in this analysis"),
});
export type LeadAnalysis = z.infer<typeof LeadAnalysisSchema>;

// ------------------------------------------------------------- agent 2
export const SalesDecisionSchema = z.object({
  action: SalesAction,
  reason: z.string(),
  urgency: z.enum(["low", "normal", "high"]),
  should_send_message: z.boolean(),
  product_ids: z.array(z.string()).describe("ids of products referenced by this action; must be active products from the catalogue"),
  question_focus: z.string().describe("if asking a question: the ONE thing to find out next"),
  talking_points: z.array(z.string()).describe("what the reply should cover, grounded in the conversation"),
  next_follow_up_hours: z.number().nullable(),
  handoff_reason: z.string(),
  handoff_priority: HandoffPriority,
  confidence: z.number(),
});
export type SalesDecision = z.infer<typeof SalesDecisionSchema>;

// ------------------------------------------------------------- agent 3
export const ResponseDraftSchema = z.object({
  messages: z.array(z.string()).describe("1-4 short DM bubbles"),
  claims_used: z.array(z.string()).describe("ids of facts from the FACTS block that the messages rely on"),
});
export type ResponseDraft = z.infer<typeof ResponseDraftSchema>;

// ------------------------------------------------------------- safety
export const SafetyVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.object({ type: z.string(), detail: z.string() })),
});
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;

// ------------------------------------------------------------- records
export const ProductType = z.enum(["course", "kit", "course_and_kit", "coaching", "training", "mentorship", "membership"]);
export type ProductType = z.infer<typeof ProductType>;

export interface Product {
  id: string;
  name: string;
  type: ProductType;
  active: boolean;
  price: number | null;
  currency: string;
  payment_plan_available: boolean;
  payment_plan_description: string | null;
  includes: string[];
  excludes: string[];
  checkout_url: string | null;
  payment_plan_checkout_url: string | null;
  booking_url: string | null;
  stock_required: boolean;
  sku: string | null;
  external_ids: Record<string, string>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockItem {
  sku: string;
  product_name: string;
  stock_quantity: number | null;
  stock_status: "in_stock" | "low_stock" | "out_of_stock" | "unknown";
  fulfilment_days: number | null;
  fulfilment_verified: boolean;
  shipping_enabled: boolean;
  updated_at: string;
}

export interface SocialProof {
  id: string;
  student_name_or_alias: string;
  problem_before: string | null;
  result: string | null;
  quote: string | null;
  approved_for_use: boolean;
  source: string | null;
  tags: string[];
}

export interface Lead {
  id: string;
  platform: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: string;
  lead_temperature: LeadTemperature;
  lead_score: number;
  experience_level: string;
  current_job: string | null;
  main_goal: string | null;
  pain_points: string[];
  objections: string[];
  budget_concern: boolean;
  payment_plan_interest: boolean;
  kit_needed: boolean;
  kit_interest: boolean;
  course_interest: boolean;
  coaching_interest: boolean;
  call_interest: boolean;
  recommended_offer: string | null;
  ai_summary: string | null;
  analysis: LeadAnalysis | null;
  last_inbound_message_at: string | null;
  last_outbound_message_at: string | null;
  first_response_at: string | null;
  follow_up_due_at: string | null;
  follow_up_count: number;
  automation_status: "active" | "stopped";
  stop_reason: string | null;
  human_takeover: boolean;
  human_takeover_at: string | null;
  handoff_required: boolean;
  handoff_reason: string | null;
  handoff_priority: HandoffPriority | null;
  handoff_created_at: string | null;
  handoff_resolved_at: string | null;
  call_booked: boolean;
  purchased: boolean;
  customer_value: number;
  needs_processing: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  platform: string;
  platform_message_id: string | null;
  direction: "inbound" | "outbound";
  content: string;
  sender_type: "lead" | "ai" | "human" | "system";
  ai_generated: boolean;
  human_generated: boolean;
  outbound_message_id: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface Purchase {
  id: string;
  lead_id: string | null;
  product_id: string | null;
  provider: string;
  provider_transaction_id: string;
  amount: number;
  currency: string;
  status: "paid" | "refunded" | "disputed" | "pending";
  is_payment_plan: boolean;
  customer_email: string | null;
  attribution: string | null;
  purchased_at: string;
}

export interface FollowUp {
  id: string;
  lead_id: string;
  scheduled_at: string;
  reason: string;
  context: string;
  attempt_number: number;
  status: "scheduled" | "cancelled" | "sent" | "skipped" | "completed";
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboundMessage {
  id: string;
  lead_id: string;
  batch_id: string;
  position: number;
  content: string;
  status: "draft" | "queued" | "sent" | "failed" | "discarded";
  idempotency_key: string;
  trigger: "reply" | "followup";
  trigger_ref: string | null;
  decision_action: string | null;
  provider_message_id: string | null;
  error: string | null;
  attempts: number;
  edited_by_human: boolean;
  created_at: string;
  sent_at: string | null;
}
