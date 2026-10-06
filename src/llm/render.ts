import type { Message } from "../domain/types.js";
import type { AnalysisInput, Fact, ResponseInput, SupervisorInput, ValidateInput } from "./provider.js";

/** Turns structured inputs into the text blocks sent to the model. Shared by every real LLM provider. */

export function renderConversation(messages: Message[]): string {
  return messages
    .map((m) => {
      const who = m.direction === "inbound" ? "lead" : "lee";
      const at = m.created_at.slice(0, 16).replace("T", " ");
      // Strip anything that looks like our own tags so lead text can't close a block early.
      const text = m.content.replace(/<\/?[a-z_]+>/gi, "");
      return `[${at}] ${who}: ${text}`;
    })
    .join("\n");
}

export function renderFacts(facts: Fact[]): string {
  if (!facts.length) return "(no facts available — do not state any prices, links, inclusions, stock or shipping details)";
  return facts.map((f) => `${f.id} [${f.type}${f.product_id ? ` · ${f.product_id}` : ""}]: ${f.text}`).join("\n");
}

export function analysisUserText(i: AnalysisInput): string {
  return [
    `<previous_analysis>\n${i.previous ? JSON.stringify(i.previous) : "(none)"}\n</previous_analysis>`,
    `<known_purchases>\n${i.purchasedProductNames.join(", ") || "(none)"}\n</known_purchases>`,
    `<conversation>\n${renderConversation(i.conversation)}\n</conversation>`,
  ].join("\n\n");
}

export function supervisorUserText(i: SupervisorInput): string {
  const lead = {
    username: i.lead.username,
    status: i.lead.status,
    lead_score: i.score,
    call_booked: i.callBooked,
    follow_ups_sent: i.followUpsSent,
  };
  return [
    `<trigger>${i.trigger}${i.followUpContext ? ` — follow-up context: ${i.followUpContext}` : ""}</trigger>`,
    `<lead>\n${JSON.stringify(lead)}\n</lead>`,
    `<analysis>\n${JSON.stringify(i.analysis)}\n</analysis>`,
    `<catalogue>\n${JSON.stringify(i.catalogue, null, 1)}\n</catalogue>`,
    `<default_booking_url_available>${i.defaultBookingUrl ? "yes" : "no"}</default_booking_url_available>`,
    `<offers_made>\n${JSON.stringify(i.offersMade)}\n</offers_made>`,
    `<purchases>\n${JSON.stringify(i.purchasedProductIds)}\n</purchases>`,
    `<conversation>\n${renderConversation(i.conversation)}\n</conversation>`,
  ].join("\n\n");
}

export function responseUserText(i: ResponseInput): string {
  const parts = [
    `<decision>\n${JSON.stringify({
      action: i.decision.action,
      reason: i.decision.reason,
      question_focus: i.decision.question_focus,
      talking_points: i.decision.talking_points,
    })}\n</decision>`,
    `<lead_profile>\n${JSON.stringify({
      experience_level: i.analysis.experience_level,
      life_context: i.analysis.life_context,
      main_goal: i.analysis.main_goal,
      pain_points: i.analysis.pain_points,
      money_objection_type: i.analysis.money_objection_type,
    })}\n</lead_profile>`,
    `<facts>\n${renderFacts(i.facts)}\n</facts>`,
    `<conversation>\n${renderConversation(i.conversation)}\n</conversation>`,
  ];
  if (i.trigger === "followup") {
    parts.unshift(
      `<follow_up>this is a follow-up: she hasn't replied since lee's last message. reference what she actually said earlier (${i.followUpContext ?? ""}). never write "just following up" or "just checking in". keep it to 1-2 bubbles and make it easy to reply or say no.</follow_up>`,
    );
  }
  if (i.previousIssues?.length) {
    parts.push(`<rejected_previous_draft_issues>\n${i.previousIssues.join("\n")}\nfix these.\n</rejected_previous_draft_issues>`);
  }
  return parts.join("\n\n");
}

export function validateUserText(i: ValidateInput): string {
  return [
    `<facts>\n${renderFacts(i.facts)}\n</facts>`,
    `<conversation>\n${renderConversation(i.conversation)}\n</conversation>`,
    `<drafts>\n${i.messages.map((m, n) => `${n + 1}. ${m}`).join("\n")}\n</drafts>`,
  ].join("\n\n");
}
