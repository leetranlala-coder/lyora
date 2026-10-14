import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { ManualScheduler } from "../src/scheduler/scheduler.js";
import { MockMessagingProvider } from "../src/integrations/messaging/mock.js";
import type { Req } from "../src/server/http.js";
import { FakeClock, START, seedFixtures } from "./helpers.js";

const auth = "Basic " + Buffer.from("lee:pw").toString("base64");
function req(method: string, path: string, opts: { body?: string; headers?: Record<string, string>; form?: Record<string, string | string[]> } = {}): Req {
  const url = new URL(path, "http://localhost:3000");
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.form ?? {})) for (const x of [v].flat()) form.append(k, x);
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: { host: "localhost:3000", origin: "http://localhost:3000", authorization: auth, ...opts.headers },
    rawBody: opts.body ?? form.toString(),
    form,
    params: {},
  };
}

function app() {
  const cfg = buildConfig({ DATABASE_PATH: ":memory:", ADMIN_PASSWORD: "pw", ADMIN_USERNAME: "lee", MESSAGING_PROVIDER: "mock", NODE_ENV: "test" });
  const clock = new FakeClock(START);
  const messaging = new MockMessagingProvider();
  const a = buildApp({ cfg, clock, scheduler: new ManualScheduler(), messaging });
  (a.agent.ctx.cfg as { BUBBLE_DELAY_MS: number }).BUBBLE_DELAY_MS = 0;
  seedFixtures(a.repos, clock.now().toISOString());
  return { ...a, clock, messaging };
}

describe("http server", () => {
  it("defaults to draft mode", () => {
    expect(buildConfig({}).SEND_MODE).toBe("draft");
  });

  it("webhook -> draft -> lee approves from the dashboard -> sent", async () => {
    const a = app();
    const body = JSON.stringify({ sender_id: "ig_1", message_id: "m1", text: "hi i'm a complete beginner, can you tell me about the course?", username: "nailbabe", timestamp: a.clock.now().toISOString() });
    const r = await a.router.handle(req("POST", "/webhooks/mock", { body }));
    expect(r.status).toBe(200);
    const dup = await a.router.handle(req("POST", "/webhooks/mock", { body }));
    expect(JSON.parse(dup.body).duplicates).toBe(1);

    a.clock.advanceMinutes(5);
    await a.agent.tick(); // periodic safety check picks it up
    const lead = a.repos.leads.findByUsername("nailbabe")!;
    const drafts = a.repos.outbound.forLead(lead.id).filter((o) => o.status === "draft");
    expect(drafts.length).toBeGreaterThan(0);
    expect(a.messaging.sent).toHaveLength(0);

    const page = await a.router.handle(req("GET", `/admin/leads/${lead.id}`));
    expect(page.status).toBe(200);
    expect(page.body).toContain("approve &amp; send");

    const edited = drafts.map((d, i) => (i === 0 ? "hi lovely, thank you for messaging xx" : d.content));
    const approve = await a.router.handle(req("POST", `/admin/drafts/${drafts[0]!.batch_id}/approve`, { form: { m: edited } }));
    expect(approve.status).toBe(303);
    expect(a.messaging.sent[0]!.text).toBe("hi lovely, thank you for messaging xx");
    expect(a.repos.outbound.get(drafts[0]!.id)!.edited_by_human).toBe(true);
  });

  it("admin requires auth and blocks cross-site posts", async () => {
    const a = app();
    expect((await a.router.handle(req("GET", "/admin", { headers: { authorization: "" } }))).status).toBe(401);
    expect((await a.router.handle(req("POST", "/admin/leads/x/takeover", { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    for (const p of ["/admin", "/admin/leads", "/admin/drafts", "/admin/handoffs", "/admin/analytics", "/admin/products", "/admin/purchases"]) {
      expect((await a.router.handle(req("GET", p))).status).toBe(200);
    }
  });

  it("take over / resume from the dashboard", async () => {
    const a = app();
    a.agent.ingestInbound({ platform: "instagram", platform_user_id: "ig_2", platform_message_id: "z1", text: "hi", sent_at: a.clock.now().toISOString() });
    const lead = a.repos.leads.findByPlatformUser("instagram", "ig_2")!;
    await a.router.handle(req("POST", `/admin/leads/${lead.id}/takeover`));
    expect(a.repos.leads.get(lead.id)!.human_takeover).toBe(true);
    await a.router.handle(req("POST", `/admin/leads/${lead.id}/resume`));
    expect(a.repos.leads.get(lead.id)!.human_takeover).toBe(false);
  });

  it("rejects unsigned payment webhooks and protects /internal/tick", async () => {
    const a = app();
    expect((await a.router.handle(req("POST", "/webhooks/stripe", { body: "{}" }))).status).toBe(401);
    expect((await a.router.handle(req("POST", "/internal/tick"))).status).toBe(401);
  });
});
