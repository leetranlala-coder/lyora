import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import { LLMUnavailableError } from "../src/llm/provider.js";
import { LeadAnalysisSchema, ResponseDraftSchema, SafetyVerdictSchema, SalesDecisionSchema } from "../src/domain/types.js";
import { makeHarness } from "./helpers.js";
import { MockLLMProvider } from "../src/llm/mock.js";

/** A stand-in for the SDK client: records the request, returns a canned response. */
function fakeClient(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (body: Record<string, unknown>) => {
        calls.push(body);
        return { model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: null, ...response };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("anthropic provider", () => {
  it("all four schemas convert to structured-output JSON schemas", () => {
    for (const s of [LeadAnalysisSchema, SalesDecisionSchema, ResponseDraftSchema, SafetyVerdictSchema]) {
      const fmt = zodOutputFormat(s) as unknown as { type: string; schema: Record<string, unknown> };
      expect(fmt.type).toBe("json_schema");
      expect(fmt.schema.type).toBe("object");
    }
  });

  it("sends the versioned prompt as a cached system block, with effort + format", async () => {
    const { client, calls } = fakeClient({ parsed_output: { messages: ["hi lovely xx"], claims_used: [] } });
    const p = new AnthropicProvider({ model: "claude-opus-5-5", effort: "medium" }, client);
    const analysis = (await new MockLLMProvider().generateLeadAnalysis({ conversation: [], previous: null, purchasedProductNames: [] })).output;
    const r = await p.generateResponse({
      trigger: "reply",
      decision: { action: "NURTURE", reason: "", urgency: "normal", should_send_message: true, product_ids: [], question_focus: "", talking_points: [], next_follow_up_hours: null, handoff_reason: "", handoff_priority: "normal", confidence: 1 },
      analysis,
      conversation: [],
      facts: [],
    });
    expect(r.output.messages).toEqual(["hi lovely xx"]);
    expect(r.promptVersion).toMatch(/\+voice/);
    const body = calls[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    const system = body.system as { text: string; cache_control: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).toContain("how lee writes"); // brand voice injected
    expect((body.output_config as { effort: string }).effort).toBe("medium");
    expect(body).not.toHaveProperty("thinking"); // Opus 5.5: thinking is adaptive by default
  });

  it("turns a refusal into LLMUnavailableError(refusal) and the pipeline hands off", async () => {
    const { client } = fakeClient({ stop_reason: "refusal" });
    const llm = new AnthropicProvider({ model: "claude-opus-5-5", effort: "medium" }, client);
    await expect(llm.generateLeadAnalysis({ conversation: [], previous: null, purchasedProductNames: [] })).rejects.toBeInstanceOf(LLMUnavailableError);

    const h = makeHarness({ llm });
    const { lead, result } = await h.dm("hi there");
    expect(result.status).toBe("handoff");
    expect(h.repos.leads.get(lead.id)!.handoff_reason).toMatch(/declined/);
    expect(h.repos.messages.unprocessedInbound(lead.id)).toHaveLength(0);
  });

  it("missing structured output is treated as unavailable, not guessed", async () => {
    const { client } = fakeClient({ stop_reason: "max_tokens", parsed_output: null });
    const llm = new AnthropicProvider({ model: "claude-opus-5-5", effort: "medium" }, client);
    await expect(llm.validateResponse({ messages: ["x"], facts: [], conversation: [] })).rejects.toMatchObject({ kind: "invalid_output" });
  });
});
