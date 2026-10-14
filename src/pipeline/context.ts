import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repositories.js";
import type { LLMProvider } from "../llm/provider.js";
import type { MessagingProvider } from "../integrations/messaging/provider.js";
import type { Clock } from "../util/time.js";

/** Everything the pipeline needs, injected so tests can swap any piece. */
export interface AgentContext {
  repos: Repos;
  llm: LLMProvider;
  messaging: MessagingProvider;
  cfg: AgentSettings;
  clock: Clock;
  workerId: string;
}

export type AgentSettings = Pick<
  AppConfig,
  | "AGENT_ENABLED"
  | "SEND_MODE"
  | "BUSINESS_TIMEZONE"
  | "INBOUND_QUIET_PERIOD_SECONDS"
  | "CONFIDENCE_THRESHOLD"
  | "HOT_LEAD_THRESHOLD"
  | "VERY_HOT_LEAD_THRESHOLD"
  | "HIGH_TICKET_THRESHOLD"
  | "MAX_AUTOMATED_FOLLOWUPS"
  | "FOLLOWUP_INTERVAL_HOURS"
  | "MINIMUM_HOURS_BETWEEN_FOLLOWUPS"
  | "MESSAGING_WINDOW_HOURS"
  | "FOLLOWUP_SEND_START_HOUR"
  | "FOLLOWUP_SEND_END_HOUR"
  | "AUTO_TAKEOVER_ON_HUMAN_REPLY"
  | "LOCK_TTL_SECONDS"
  | "DEFAULT_BOOKING_URL"
> & { BUBBLE_DELAY_MS: number };

export function settingsFrom(cfg: AppConfig, overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    AGENT_ENABLED: cfg.AGENT_ENABLED,
    SEND_MODE: cfg.SEND_MODE,
    BUSINESS_TIMEZONE: cfg.BUSINESS_TIMEZONE,
    INBOUND_QUIET_PERIOD_SECONDS: cfg.INBOUND_QUIET_PERIOD_SECONDS,
    CONFIDENCE_THRESHOLD: cfg.CONFIDENCE_THRESHOLD,
    HOT_LEAD_THRESHOLD: cfg.HOT_LEAD_THRESHOLD,
    VERY_HOT_LEAD_THRESHOLD: cfg.VERY_HOT_LEAD_THRESHOLD,
    HIGH_TICKET_THRESHOLD: cfg.HIGH_TICKET_THRESHOLD,
    MAX_AUTOMATED_FOLLOWUPS: cfg.MAX_AUTOMATED_FOLLOWUPS,
    FOLLOWUP_INTERVAL_HOURS: cfg.FOLLOWUP_INTERVAL_HOURS,
    MINIMUM_HOURS_BETWEEN_FOLLOWUPS: cfg.MINIMUM_HOURS_BETWEEN_FOLLOWUPS,
    MESSAGING_WINDOW_HOURS: cfg.MESSAGING_WINDOW_HOURS,
    FOLLOWUP_SEND_START_HOUR: cfg.FOLLOWUP_SEND_START_HOUR,
    FOLLOWUP_SEND_END_HOUR: cfg.FOLLOWUP_SEND_END_HOUR,
    AUTO_TAKEOVER_ON_HUMAN_REPLY: cfg.AUTO_TAKEOVER_ON_HUMAN_REPLY,
    LOCK_TTL_SECONDS: cfg.LOCK_TTL_SECONDS,
    DEFAULT_BOOKING_URL: cfg.DEFAULT_BOOKING_URL,
    BUBBLE_DELAY_MS: Number(process.env.BUBBLE_DELAY_MS ?? 1500),
    ...overrides,
  };
}
