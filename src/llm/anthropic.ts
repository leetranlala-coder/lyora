import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import {
  LeadAnalysisSchema,
  ResponseDraftSchema,
  SafetyVerdictSchema,
  SalesDecisionSchema,
} from "../domain/types.js";
import { loadPrompt, render, type Prompt } from "../prompts/loader.js";
import { log } from "../logger.js";
import {
  LLMUnavailableError,
  type AnalysisInput,
  type LLMProvider,
  type LLMResult,
  type ResponseInput,
  type SupervisorInput,
  type ValidateInput,
} from "./provider.js";
import { analysisUserText, responseUserText, supervisorUserText, validateUserText } from "./render.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude implementation of the LLM provider. Every call uses structured outputs
 * (validated against the Zod schema) so business logic never parses free text.
 *
 * Refusals are NOT retried on another model: for a sales assistant, a declined
 * request is a signal that Lee should look at the conversation, so the pipeline
 * turns LLMUnavailableError("refusal") into a human handoff.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    private opts: { apiKey?: string; model: string; effort: Effort },
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  private async call<S extends z.ZodType>(
    prompt: Prompt,
    system: string,
    userText: string,
    schema: S,
    effort: Effort,
  ): Promise<LLMResult<z.infer<S>>> {
    let response;
    try {
      response = await this.client.messages.parse({
        model: this.opts.model,
        max_tokens: 16000,
        // Stable system prompt first so it can be cached across leads.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
        output_config: { effort, format: zodOutputFormat(schema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMUnavailableError("rate limited", "api_error");
      } else if (err instanceof Anthropic.APIError) {
        log.error("anthropic api error", { prompt: prompt.name, status: err.status });
        throw new LLMUnavailableError(`api error ${err.status ?? ""}`, "api_error");
      }
      throw err;
    }

    if (response.stop_reason === "refusal") {
      throw new LLMUnavailableError("model declined this request", "refusal");
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new LLMUnavailableError(`no valid structured output (stop_reason=${response.stop_reason})`, "invalid_output");
    }
    return {
      output: response.parsed_output as z.infer<S>,
      model: response.model,
      promptName: prompt.name,
      promptVersion: prompt.version,
    };
  }

  generateLeadAnalysis(input: AnalysisInput) {
    const p = loadPrompt("lead-analysis");
    return this.call(p, p.body, analysisUserText(input), LeadAnalysisSchema, this.opts.effort);
  }

  generateSalesDecision(input: SupervisorInput) {
    const p = loadPrompt("sales-supervisor");
    return this.call(p, p.body, supervisorUserText(input), SalesDecisionSchema, this.opts.effort);
  }

  generateResponse(input: ResponseInput) {
    const p = loadPrompt("response-generator");
    const voice = loadPrompt("brand-voice");
    const system = render(p.body, { brand_voice: voice.body, brand_voice_name: `brand-voice v${voice.version}` });
    const prompt = { ...p, version: `${p.version}+voice${voice.version}` };
    return this.call(prompt, system, responseUserText(input), ResponseDraftSchema, this.opts.effort);
  }

  validateResponse(input: ValidateInput) {
    const p = loadPrompt("safety-validator");
    return this.call(p, p.body, validateUserText(input), SafetyVerdictSchema, "low");
  }
}
