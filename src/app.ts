import { getConfig, type AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { createRepos, type Repos } from "./db/repositories.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { MockLLMProvider } from "./llm/mock.js";
import type { LLMProvider } from "./llm/provider.js";
import type { MessagingProvider, ParsedWebhook } from "./integrations/messaging/provider.js";
import { WebhookAuthError } from "./integrations/messaging/provider.js";
import { MockMessagingProvider } from "./integrations/messaging/mock.js";
import { ManyChatProvider } from "./integrations/messaging/manychat.js";
import { MetaInstagramProvider, metaVerifyChallenge } from "./integrations/messaging/meta.js";
import type { PaymentProvider } from "./integrations/payments/provider.js";
import { StripePaymentProvider } from "./integrations/payments/stripe.js";
import { PayPalPaymentProvider } from "./integrations/payments/paypal.js";
import { SquarePaymentProvider } from "./integrations/payments/square.js";
import { KajabiPaymentProvider } from "./integrations/payments/kajabi.js";
import { CalendlyBookingProvider } from "./integrations/booking/provider.js";
import { LyoraAgent } from "./pipeline/agent.js";
import { AdminActions } from "./pipeline/admin.js";
import { settingsFrom } from "./pipeline/context.js";
import { recordBooking, recordPayment } from "./pipeline/outcomes.js";
import { computeMetrics, todaySummary } from "./analytics/metrics.js";
import { InProcessScheduler, ManualScheduler, type Scheduler } from "./scheduler/scheduler.js";
import { Router, checkBasicAuth, checkSameOrigin, html, json, redirect, text, type Req, type Res } from "./server/http.js";
import * as V from "./server/views.js";
import { systemClock, type Clock } from "./util/time.js";
import { safeEqual } from "./util/ids.js";
import { log } from "./logger.js";

export interface App {
  cfg: AppConfig;
  repos: Repos;
  agent: LyoraAgent;
  admin: AdminActions;
  router: Router;
  scheduler: Scheduler;
  messaging: MessagingProvider;
}

export function buildLLM(cfg: AppConfig): LLMProvider {
  if (cfg.LLM_PROVIDER === "anthropic") {
    return new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY || undefined, model: cfg.ANTHROPIC_MODEL, effort: cfg.ANTHROPIC_EFFORT });
  }
  return new MockLLMProvider();
}

function buildMessaging(cfg: AppConfig): MessagingProvider {
  switch (cfg.MESSAGING_PROVIDER) {
    case "manychat":
      return new ManyChatProvider({ apiKey: cfg.MANYCHAT_API_KEY, webhookSecret: cfg.MANYCHAT_WEBHOOK_SECRET });
    case "meta":
      return new MetaInstagramProvider({ appSecret: cfg.META_APP_SECRET, accessToken: cfg.META_PAGE_ACCESS_TOKEN, igUserId: cfg.META_IG_USER_ID, graphBaseUrl: cfg.META_GRAPH_BASE_URL });
    default:
      return new MockMessagingProvider();
  }
}

export function buildApp(opts: { cfg?: AppConfig; clock?: Clock; scheduler?: Scheduler; llm?: LLMProvider; messaging?: MessagingProvider } = {}): App {
  const cfg = opts.cfg ?? getConfig();
  const db = openDatabase(cfg.DATABASE_PATH);
  const repos = createRepos(db);
  const llm = opts.llm ?? buildLLM(cfg);
  const messaging = opts.messaging ?? buildMessaging(cfg);
  const clock = opts.clock ?? systemClock;
  const scheduler = opts.scheduler ?? (cfg.ENABLE_IN_PROCESS_SCHEDULER ? new InProcessScheduler() : new ManualScheduler());
  const agent = new LyoraAgent({ repos, llm, messaging, cfg: settingsFrom(cfg), clock, workerId: `w${process.pid}` });
  const admin = new AdminActions(agent);
  V.setViewTimezone(cfg.BUSINESS_TIMEZONE);

  const payments: Record<string, PaymentProvider> = {
    stripe: new StripePaymentProvider(cfg.STRIPE_WEBHOOK_SECRET),
    paypal: new PayPalPaymentProvider({ clientId: cfg.PAYPAL_CLIENT_ID, clientSecret: cfg.PAYPAL_CLIENT_SECRET, webhookId: cfg.PAYPAL_WEBHOOK_ID, apiBase: cfg.PAYPAL_API_BASE }),
    square: new SquarePaymentProvider(cfg.SQUARE_WEBHOOK_SIGNATURE_KEY, cfg.SQUARE_WEBHOOK_URL),
    kajabi: new KajabiPaymentProvider(cfg.KAJABI_WEBHOOK_SECRET),
  };
  const calendly = new CalendlyBookingProvider(cfg.CALENDLY_WEBHOOK_SIGNING_KEY);

  /** Realtime mode: reply once the lead has stopped typing for the quiet period. */
  const scheduleReply = (leadIds: string[]) => {
    for (const id of leadIds) {
      scheduler.debounce(`reply:${id}`, (cfg.INBOUND_QUIET_PERIOD_SECONDS + 1) * 1000, () => agent.processLead(id));
    }
  };

  const inbound = (provider: MessagingProvider) => async (req: Req): Promise<Res> => {
    let parsed: ParsedWebhook;
    try {
      parsed = provider.parseWebhook(req.headers, req.rawBody);
    } catch (err) {
      if (err instanceof WebhookAuthError) {
        log.warn("webhook rejected", { provider: provider.name, reason: err.message });
        return text("unauthorized", 401);
      }
      return text("bad request", 400);
    }
    const { leadIds, duplicates } = agent.ingestWebhook(parsed);
    scheduleReply(leadIds);
    return json({ ok: true, accepted: leadIds.length, duplicates });
  };

  const router = new Router();
  router.get("/health", () => json({ ok: true, mode: cfg.SEND_MODE, agent: cfg.AGENT_ENABLED, llm: llm.name, messaging: messaging.name }));

  // ---------------------------------------------------------------- webhooks
  const meta = messaging instanceof MetaInstagramProvider ? messaging : new MetaInstagramProvider({ appSecret: cfg.META_APP_SECRET, accessToken: cfg.META_PAGE_ACCESS_TOKEN, igUserId: cfg.META_IG_USER_ID, graphBaseUrl: cfg.META_GRAPH_BASE_URL });
  router.get("/webhooks/instagram", (req) => {
    const challenge = metaVerifyChallenge(req.query, cfg.META_VERIFY_TOKEN);
    return challenge ? text(challenge) : text("forbidden", 403);
  });
  router.post("/webhooks/instagram", inbound(meta));
  router.post("/webhooks/manychat", inbound(messaging instanceof ManyChatProvider ? messaging : new ManyChatProvider({ apiKey: cfg.MANYCHAT_API_KEY, webhookSecret: cfg.MANYCHAT_WEBHOOK_SECRET })));
  if (messaging instanceof MockMessagingProvider && cfg.NODE_ENV !== "production") {
    router.post("/webhooks/mock", inbound(messaging));
  }
  for (const [name, p] of Object.entries(payments)) {
    router.post(`/webhooks/${name}`, async (req) => {
      try {
        const events = await p.handleWebhook(req.headers, req.rawBody);
        const results = events.map((e) => recordPayment(agent.ctx, e).status);
        return json({ ok: true, results });
      } catch (err) {
        if (err instanceof WebhookAuthError) return text("unauthorized", 401);
        log.error("payment webhook error", { provider: name, err });
        return text("error", 500);
      }
    });
  }
  router.post("/webhooks/calendly", async (req) => {
    try {
      const events = await calendly.handleBookingWebhook(req.headers, req.rawBody);
      return json({ ok: true, results: events.map((e) => recordBooking(agent.ctx, e).status) });
    } catch (err) {
      if (err instanceof WebhookAuthError) return text("unauthorized", 401);
      return text("error", 500);
    }
  });

  // ---------------------------------------------------------------- periodic safety check (external cron)
  router.post("/internal/tick", async (req) => {
    const auth = req.headers.authorization ?? "";
    if (!cfg.INTERNAL_TICK_SECRET || !safeEqual(auth, `Bearer ${cfg.INTERNAL_TICK_SECRET}`)) return text("unauthorized", 401);
    return json(await agent.tick());
  });

  // ---------------------------------------------------------------- admin
  const guard = (h: (req: Req) => Promise<Res> | Res) => async (req: Req) => checkBasicAuth(req, cfg.ADMIN_USERNAME, cfg.ADMIN_PASSWORD) ?? checkSameOrigin(req) ?? h(req);
  const page = (title: string, active: string, body: string, flash?: string) => html(V.layout(title, active, body, { mode: cfg.SEND_MODE, flash }));
  const back = (req: Req, fallback: string) => redirect(req.headers.referer && new URL(req.headers.referer).pathname.startsWith("/admin") ? new URL(req.headers.referer).pathname : fallback);

  const draftBatches = () => {
    const byBatch = new Map<string, ReturnType<typeof repos.outbound.byStatus>>();
    for (const o of repos.outbound.byStatus("draft")) byBatch.set(o.batch_id, [...(byBatch.get(o.batch_id) ?? []), o]);
    return [...byBatch.values()];
  };

  router.get(
    "/admin",
    guard(() => {
      const s = todaySummary(repos, clock.now(), cfg.BUSINESS_TIMEZONE);
      const drafts = draftBatches()
        .map((b) => ({ lead: repos.leads.get(b[0]!.lead_id)!, count: b.length, batch: b[0]!.batch_id }))
        .filter((d) => d.lead);
      return page("today", "today", V.todayPage(s as unknown as Record<string, number | string>, drafts, repos.leads.unresolvedHandoffs().slice(0, 10)));
    }),
  );
  router.get("/admin/leads", guard((req) => page("leads", "leads", V.leadsPage(repos.leads.list({ search: req.query.get("q") || undefined, temperature: req.query.get("temp") || undefined }), req.query.get("q") ?? "", req.query.get("temp") ?? ""))));
  router.get(
    "/admin/leads/:id",
    guard((req) => {
      const lead = repos.leads.get(req.params.id!);
      if (!lead) return text("not found", 404);
      const drafts = draftBatches().filter((b) => b[0]!.lead_id === lead.id);
      const products = repos.products.all();
      const bookingUrl = products.find((p) => p.id === lead.recommended_offer)?.booking_url ?? (cfg.DEFAULT_BOOKING_URL || null);
      return page(
        lead.username ?? "lead",
        "leads",
        V.leadPage({
          lead,
          messages: repos.messages.forLead(lead.id),
          drafts,
          followUps: repos.followUps.forLead(lead.id),
          purchases: repos.purchases.forLead(lead.id),
          products,
          notes: repos.notes.forLead(lead.id),
          audit: repos.audit.forLead(lead.id, 80),
          bookingUrl,
        }),
        req.query.get("flash") ?? undefined,
      );
    }),
  );
  const leadAction = (path: string, fn: (id: string, req: Req) => Promise<string | void> | string | void) =>
    router.post(
      `/admin/leads/:id/${path}`,
      guard(async (req) => {
        const flash = await fn(req.params.id!, req);
        return redirect(`/admin/leads/${encodeURIComponent(req.params.id!)}${flash ? `?flash=${encodeURIComponent(flash)}` : ""}`);
      }),
    );
  leadAction("takeover", (id) => {
    admin.takeOver(id);
    return "you've taken over — the ai is paused for this lead";
  });
  leadAction("resume", (id) => admin.resumeAi(id).warning ?? "ai resumed");
  leadAction("not-interested", (id) => {
    admin.markNotInterested(id);
    return "marked not interested";
  });
  leadAction("call-booked", (id) => {
    admin.markCallBooked(id);
    return "marked call booked";
  });
  leadAction("resolve-handoff", (id) => {
    admin.resolveHandoff(id);
    return "handoff resolved";
  });
  leadAction("purchased", (id, req) => {
    const amount = Number(req.form.get("amount") || 0);
    const productId = req.form.get("product_id") || null;
    const product = productId ? repos.products.getProductById(productId) : null;
    admin.markPurchased(id, { productId, amount: amount || product?.price || 0, paymentPlan: req.form.get("plan") === "1" });
    return "marked purchased — sales follow-ups cancelled";
  });
  leadAction("process", async (id) => {
    const r = await agent.processLead(id, { ignoreQuietPeriod: true });
    return `ai run: ${r.status}`;
  });
  router.post(
    "/admin/drafts/:batch/approve",
    guard(async (req) => {
      const r = await admin.approveDraft(req.params.batch!, req.form.getAll("m"));
      const flash = r.status === "sent" ? "sent ✓" : `not sent: ${"reason" in r ? r.reason : r.error}`;
      const leadId = repos.outbound.batch(req.params.batch!)[0]?.lead_id;
      return redirect(leadId ? `/admin/leads/${leadId}?flash=${encodeURIComponent(flash)}` : "/admin/drafts");
    }),
  );
  router.post("/admin/drafts/:batch/discard", guard((req) => (admin.discardDraft(req.params.batch!), back(req, "/admin/drafts"))));
  router.post("/admin/followups/:id/cancel", guard((req) => (admin.cancelFollowUp(req.params.id!), back(req, "/admin"))));
  router.get(
    "/admin/drafts",
    guard(() => page("drafts", "drafts", V.draftsPage(draftBatches().map((b) => ({ lead: repos.leads.get(b[0]!.lead_id)!, batch: b })).filter((r) => r.lead)))),
  );
  router.get("/admin/handoffs", guard(() => page("handoffs", "handoffs", V.handoffsPage(repos.leads.unresolvedHandoffs()))));
  router.get(
    "/admin/analytics",
    guard((req) => {
      const days = Math.min(365, Math.max(1, Number(req.query.get("days") ?? 30)));
      const to = clock.now();
      const from = new Date(to.getTime() - days * 86_400_000);
      return page("analytics", "analytics", V.analyticsPage(computeMetrics(repos, from.toISOString(), new Date(to.getTime() + 1000).toISOString()), days));
    }),
  );
  router.get("/admin/products", guard(() => page("products", "products", V.productsPage(repos.products.all(), repos.stock.all()))));
  router.get("/admin/purchases", guard(() => page("purchases", "purchases", V.purchasesPage(repos.purchases.unmatched(), repos.purchases.all(), repos.leads.list({ limit: 300 })))));
  router.post("/admin/purchases/:id/match", guard((req) => (admin.matchPurchase(req.params.id!, req.form.get("lead_id") ?? ""), redirect("/admin/purchases"))));
  router.get("/", () => redirect("/admin"));

  // ---------------------------------------------------------------- periodic safety check (in-process)
  scheduler.every("safety-check", cfg.MESSAGE_CHECK_INTERVAL_MINUTES * 60_000, () => agent.tick());

  return { cfg, repos, agent, admin, router, scheduler, messaging };
}
