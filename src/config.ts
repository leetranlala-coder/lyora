import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * All runtime configuration comes from environment variables.
 * Secrets are read here and nowhere else, and are never logged.
 * See .env.example for documentation of every variable.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const str = (def = "") => z.string().optional().transform((v) => (v === undefined ? def : v));

const EnvSchema = z.object({
  NODE_ENV: str("development"),
  PORT: num(3000),
  PUBLIC_BASE_URL: str("http://localhost:3000"),
  DATABASE_PATH: str("./data/lyora.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),

  // ---- agent behaviour ----
  AGENT_ENABLED: bool(true),
  /** draft = AI writes replies for review, never sends. auto = AI may send when every safeguard passes. */
  SEND_MODE: z.enum(["draft", "auto"]).optional().default("draft"),
  BUSINESS_TIMEZONE: str("Australia/Perth"),
  MESSAGE_CHECK_INTERVAL_MINUTES: num(30),
  /** Wait this long after the latest inbound message before replying, so a lead can finish typing. */
  INBOUND_QUIET_PERIOD_SECONDS: num(60),
  CONFIDENCE_THRESHOLD: num(0.6),
  HOT_LEAD_THRESHOLD: num(51),
  VERY_HOT_LEAD_THRESHOLD: num(76),
  /** Leads at or above this value (AUD) on a recommended offer are handed to Lee when very hot. */
  HIGH_TICKET_THRESHOLD: num(1000),
  MAX_AUTOMATED_FOLLOWUPS: num(2),
  FOLLOWUP_INTERVAL_HOURS: num(20),
  MINIMUM_HOURS_BETWEEN_FOLLOWUPS: num(18),
  /** Instagram only allows automated replies within 24h of the lead's last message. */
  MESSAGING_WINDOW_HOURS: num(24),
  /** Follow-ups are only sent between these local hours (business timezone). */
  FOLLOWUP_SEND_START_HOUR: num(9),
  FOLLOWUP_SEND_END_HOUR: num(20),
  /** If Lee replies manually in the Instagram app, pause the AI for that lead. */
  AUTO_TAKEOVER_ON_HUMAN_REPLY: bool(true),
  LOCK_TTL_SECONDS: num(120),

  // ---- LLM ----
  LLM_PROVIDER: z.enum(["anthropic", "mock"]).optional(),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().default("medium"),

  // ---- messaging ----
  MESSAGING_PROVIDER: z.enum(["mock", "manychat", "meta"]).optional().default("mock"),
  MANYCHAT_API_KEY: str(),
  MANYCHAT_WEBHOOK_SECRET: str(),
  META_APP_SECRET: str(),
  META_VERIFY_TOKEN: str(),
  META_PAGE_ACCESS_TOKEN: str(),
  META_IG_USER_ID: str(),
  META_GRAPH_BASE_URL: str("https://graph.instagram.com/v21.0"),

  // ---- payments ----
  STRIPE_WEBHOOK_SECRET: str(),
  PAYPAL_CLIENT_ID: str(),
  PAYPAL_CLIENT_SECRET: str(),
  PAYPAL_WEBHOOK_ID: str(),
  PAYPAL_API_BASE: str("https://api-m.paypal.com"),
  SQUARE_WEBHOOK_SIGNATURE_KEY: str(),
  SQUARE_WEBHOOK_URL: str(),
  KAJABI_WEBHOOK_SECRET: str(),

  // ---- booking ----
  CALENDLY_WEBHOOK_SIGNING_KEY: str(),
  DEFAULT_BOOKING_URL: str(),

  // ---- admin / internal ----
  ADMIN_USERNAME: str("lee"),
  ADMIN_PASSWORD: str(),
  INTERNAL_TICK_SECRET: str(),
  ENABLE_IN_PROCESS_SCHEDULER: bool(true),
});

export type AppConfig = ReturnType<typeof buildConfig>;

export function buildConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.parse(env);
  const llmProvider = parsed.LLM_PROVIDER ?? (parsed.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  return { ...parsed, LLM_PROVIDER: llmProvider } as const;
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if (!cached) {
    // Load .env if present (Node's built-in loader; real environment variables win).
    if (process.env.NODE_ENV !== "test" && existsSync(".env")) process.loadEnvFile(".env");
    cached = buildConfig();
  }
  return cached;
}

/** Names of config keys that must never appear in logs or the admin UI. */
export const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "MANYCHAT_API_KEY",
  "MANYCHAT_WEBHOOK_SECRET",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "META_PAGE_ACCESS_TOKEN",
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_SECRET",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "KAJABI_WEBHOOK_SECRET",
  "CALENDLY_WEBHOOK_SIGNING_KEY",
  "ADMIN_PASSWORD",
  "INTERNAL_TICK_SECRET",
] as const;
