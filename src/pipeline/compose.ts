import type { LeadAnalysis, Message, SalesDecision } from "../domain/types.js";
import type { Fact } from "../llm/provider.js";
import { validateMessages, type SafetyIssue } from "../agents/safety.js";
import type { AgentContext } from "./context.js";

/**
 * Response generator + safety gate.
 * Generate -> validate -> (on failure) regenerate ONCE with the issues -> validate.
 * If the second draft also fails, the caller hands off to Lee and nothing is sent.
 */
export async function composeValidated(
  ctx: AgentContext,
  input: {
    leadId: string;
    runId: string;
    trigger: "reply" | "followup";
    decision: SalesDecision;
    analysis: LeadAnalysis;
    conversation: Message[];
    facts: Fact[];
    followUpContext?: string;
  },
): Promise<{ ok: true; messages: string[] } | { ok: false; issues: SafetyIssue[] }> {
  const now = () => ctx.clock.now().toISOString();
  let previousIssues: string[] | undefined;
  let lastIssues: SafetyIssue[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const gen = await ctx.llm.generateResponse({
      trigger: input.trigger,
      decision: input.decision,
      analysis: input.analysis,
      conversation: input.conversation,
      facts: input.facts,
      followUpContext: input.followUpContext,
      previousIssues,
    });
    const messages = gen.output.messages.map(cleanBubble).filter(Boolean);
    ctx.repos.audit.write({
      lead_id: input.leadId,
      run_id: input.runId,
      stage: "response",
      event: `draft_attempt_${attempt}`,
      prompt_name: gen.promptName,
      prompt_version: gen.promptVersion,
      model: gen.model,
      data: { messages, claims_used: gen.output.claims_used, facts: input.facts.map((f) => f.id + ": " + f.text) },
      now: now(),
    });

    const verdict = await validateMessages(ctx.llm, {
      messages,
      facts: input.facts,
      conversation: input.conversation,
      action: input.decision.action,
    });
    ctx.repos.audit.write({
      lead_id: input.leadId,
      run_id: input.runId,
      stage: "safety",
      event: verdict.approved ? "approved" : "rejected",
      prompt_name: "safety-validator",
      prompt_version: verdict.promptVersion ?? null,
      model: verdict.model ?? null,
      data: { attempt, issues: verdict.issues },
      now: now(),
    });
    if (verdict.approved) return { ok: true, messages };
    lastIssues = verdict.issues;
    previousIssues = verdict.issues.filter((i) => i.severity === "block").map((i) => `${i.type}: ${i.detail}`);
  }
  return { ok: false, issues: lastIssues };
}

/** House style: no em/en dashes in Lee's messages (she never uses them), tidy whitespace. */
export function cleanBubble(m: string): string {
  return m
    .replace(/\s*[\u2014]\s*/g, ", ")
    .replace(/\s+[\u2013]\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}
