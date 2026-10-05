import { openDatabase } from "../src/db/database.js";
import { createRepos, type Repos } from "../src/db/repositories.js";
import { MockLLMProvider } from "../src/llm/mock.js";
import { MockMessagingProvider } from "../src/integrations/messaging/mock.js";
import { LyoraAgent } from "../src/pipeline/agent.js";
import type { AgentSettings } from "../src/pipeline/context.js";
import type { LLMProvider } from "../src/llm/provider.js";
import type { Product } from "../src/domain/types.js";

process.env.NODE_ENV = "test";

export class FakeClock {
  constructor(public t: Date) {}
  now() {
    return new Date(this.t);
  }
  advanceMinutes(m: number) {
    this.t = new Date(this.t.getTime() + m * 60_000);
  }
  advanceHours(h: number) {
    this.advanceMinutes(h * 60);
  }
}

/** 10:00am Perth time. */
export const START = new Date("2026-10-06T02:00:00Z");

export const SETTINGS: AgentSettings = {
  AGENT_ENABLED: true,
  SEND_MODE: "draft",
  BUSINESS_TIMEZONE: "Australia/Perth",
  INBOUND_QUIET_PERIOD_SECONDS: 60,
  CONFIDENCE_THRESHOLD: 0.6,
  HOT_LEAD_THRESHOLD: 51,
  VERY_HOT_LEAD_THRESHOLD: 76,
  HIGH_TICKET_THRESHOLD: 1000,
  MAX_AUTOMATED_FOLLOWUPS: 2,
  FOLLOWUP_INTERVAL_HOURS: 20,
  MINIMUM_HOURS_BETWEEN_FOLLOWUPS: 18,
  MESSAGING_WINDOW_HOURS: 24,
  FOLLOWUP_SEND_START_HOUR: 9,
  FOLLOWUP_SEND_END_HOUR: 20,
  AUTO_TAKEOVER_ON_HUMAN_REPLY: true,
  LOCK_TTL_SECONDS: 120,
  DEFAULT_BOOKING_URL: "",
  BUBBLE_DELAY_MS: 0,
};

export const COURSE_URL = "https://www.lyora.com.au/offers/course/checkout";
export const PLAN_URL = "https://www.lyora.com.au/offers/course-plan/checkout";
export const BUNDLE_URL = "https://www.lyora.com.au/offers/vip/checkout";
export const BOOKING_URL = "https://calendly.com/lyora/chat";

type ProductInput = Omit<Product, "created_at" | "updated_at">;
const product = (p: Partial<ProductInput> & Pick<ProductInput, "id" | "name" | "type">): ProductInput => ({
  active: true,
  price: null,
  currency: "AUD",
  payment_plan_available: false,
  payment_plan_description: null,
  includes: [],
  excludes: [],
  checkout_url: null,
  payment_plan_checkout_url: null,
  booking_url: null,
  stock_required: false,
  sku: null,
  external_ids: {},
  notes: null,
  ...p,
});

export function seedFixtures(repos: Repos, now: string) {
  repos.products.upsert(
    product({
      id: "online-course",
      name: "The Online Nail Course",
      type: "course",
      price: 450,
      payment_plan_available: true,
      payment_plan_description: "9 weekly payments of $50",
      includes: ["16 modules, lifetime access", "prep, retention and lifting troubleshooting", "lyora lights community", "the no-lift method guide"],
      checkout_url: COURSE_URL,
      payment_plan_checkout_url: PLAN_URL,
      external_ids: { kajabi_offer_id: "2151275161" },
    }),
    now,
  );
  repos.products.upsert(
    product({
      id: "vip-course-kit",
      name: "The Lyora VIP Experience (course + full kit)",
      type: "course_and_kit",
      price: 1950,
      payment_plan_available: true,
      payment_plan_description: "8 payments of $250",
      includes: ["everything in the online course", "full professional kit"],
      checkout_url: BUNDLE_URL,
      stock_required: true,
      sku: "KIT-PRO",
    }),
    now,
  );
  repos.products.upsert(
    product({ id: "pro-kit", name: "The Lyora Full Professional Kit", type: "kit", price: 1200, stock_required: true, sku: "KIT-PRO" }),
    now,
  );
  repos.products.upsert(product({ id: "mentorship", name: "The Lyora Mentorship", type: "mentorship", price: null }), now);
  repos.products.upsert(product({ id: "old-course", name: "Archived course", type: "course", price: 99, active: false }), now);
  repos.stock.upsert(
    { sku: "KIT-PRO", product_name: "Full Professional Kit", stock_quantity: 5, stock_status: "in_stock", fulfilment_days: 2, fulfilment_verified: false, shipping_enabled: true },
    now,
  );
}

export function makeHarness(opts: { settings?: Partial<AgentSettings>; llm?: LLMProvider } = {}) {
  const db = openDatabase(":memory:");
  const repos = createRepos(db);
  const clock = new FakeClock(START);
  seedFixtures(repos, clock.now().toISOString());
  const messaging = new MockMessagingProvider();
  const llm = opts.llm ?? new MockLLMProvider();
  const agent = new LyoraAgent({ repos, llm, messaging, cfg: { ...SETTINGS, ...opts.settings }, clock, workerId: "test" });
  let seq = 0;

  /** Simulate the lead sending a DM, then let the quiet period pass and process. */
  async function dm(text: string, user = "ig_123", username = "nailbabe") {
    seq++;
    agent.ingestInbound({
      platform: "instagram",
      platform_user_id: user,
      platform_message_id: `mid_${user}_${seq}`,
      text,
      sent_at: clock.now().toISOString(),
      username,
    });
    clock.advanceMinutes(2);
    const lead = repos.leads.findByPlatformUser("instagram", user)!;
    const result = await agent.processLead(lead.id);
    return { lead: repos.leads.get(lead.id)!, result };
  }

  function drafts(leadId: string) {
    return repos.outbound.forLead(leadId).filter((o) => o.status === "draft");
  }
  function outboundText(leadId: string) {
    return repos.outbound
      .forLead(leadId)
      .filter((o) => o.status !== "discarded")
      .map((o) => o.content)
      .join("\n");
  }

  return { db, repos, clock, messaging, llm, agent, dm, drafts, outboundText };
}
