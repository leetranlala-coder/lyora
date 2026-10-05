import type { LeadAnalysis, Lead, Message, ResponseDraft, SafetyVerdict, SalesDecision } from "../domain/types.js";

/** A fact the response generator is allowed to state. Ids are referenced in claims_used. */
export interface Fact {
  id: string;
  type:
    | "product"
    | "price"
    | "payment_plan"
    | "checkout_link"
    | "payment_plan_link"
    | "booking_link"
    | "includes"
    | "excludes"
    | "stock"
    | "fulfilment"
    | "social_proof";
  product_id?: string;
  text: string;
}

/** Catalogue view given to the supervisor (active products only). */
export interface CatalogueEntry {
  id: string;
  name: string;
  type: string;
  price: number | null;
  currency: string;
  payment_plan_available: boolean;
  payment_plan_description: string | null;
  includes: string[];
  has_checkout_url: boolean;
  has_booking_url: boolean;
  stock_required: boolean;
  stock_status: string | null;
}

export interface AnalysisInput {
  conversation: Message[];
  previous: LeadAnalysis | null;
  purchasedProductNames: string[];
}

export interface SupervisorInput {
  trigger: "reply" | "followup";
  lead: Lead;
  analysis: LeadAnalysis;
  score: number;
  conversation: Message[];
  catalogue: CatalogueEntry[];
  offersMade: { product_id: string; action: string; created_at: string }[];
  purchasedProductIds: string[];
  followUpsSent: number;
  callBooked: boolean;
  defaultBookingUrl: string | null;
  followUpContext?: string;
}

export interface ResponseInput {
  trigger: "reply" | "followup";
  decision: SalesDecision;
  analysis: LeadAnalysis;
  conversation: Message[];
  facts: Fact[];
  followUpContext?: string;
  /** Feedback from a failed safety check, used on the single regeneration attempt. */
  previousIssues?: string[];
}

export interface ValidateInput {
  messages: string[];
  facts: Fact[];
  conversation: Message[];
}

export interface LLMResult<T> {
  output: T;
  model: string;
  promptName: string;
  promptVersion: string;
}

/** The model declined to answer (stop_reason: refusal) or returned unparseable output. */
export class LLMUnavailableError extends Error {
  constructor(
    message: string,
    public readonly kind: "refusal" | "invalid_output" | "api_error",
  ) {
    super(message);
  }
}

export interface LLMProvider {
  readonly name: string;
  generateLeadAnalysis(input: AnalysisInput): Promise<LLMResult<LeadAnalysis>>;
  generateSalesDecision(input: SupervisorInput): Promise<LLMResult<SalesDecision>>;
  generateResponse(input: ResponseInput): Promise<LLMResult<ResponseDraft>>;
  validateResponse(input: ValidateInput): Promise<LLMResult<SafetyVerdict>>;
}
