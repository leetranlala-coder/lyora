import { describe, expect, it } from "vitest";
import { makeHarness, COURSE_URL, BOOKING_URL, BUNDLE_URL } from "./helpers.js";
import { MockLLMProvider } from "../src/llm/mock.js";
import { recordPayment } from "../src/pipeline/outcomes.js";

import type { ProcessResult } from "../src/pipeline/agent.js";

type Done = Extract<ProcessResult, { status: "done" }>;
const done = (r: ProcessResult): Done => {
  expect(r.status).toBe("done");
  return r as Done;
};

describe("LYORA DM scenarios", () => {
  it("1. complete beginner asking for information -> one qualifying question, no selling", async () => {
    const h = makeHarness();
    const { lead, result } = await h.dm("hiii i've always wanted to learn nails, can you tell me more about your course?");
    const r = done(result);
    expect(r.decision.action).toBe("ASK_QUALIFYING_QUESTION");
    const text = h.outboundText(lead.id);
    expect(text).not.toMatch(/\$|https?:/);
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(h.drafts(lead.id).length).toBeGreaterThan(0); // draft mode by default
    expect(h.messaging.sent).toHaveLength(0);
  });

  it("2. existing nail tech with retention problems -> course, never a kit", async () => {
    const h = makeHarness();
    await h.dm("hey i'm a nail tech, been doing nails from home for a year");
    const { result } = await h.dm("my biggest issue is my sets keep lifting after a week and clients are complaining about retention");
    const r = done(result);
    expect(["RECOMMEND_COURSE", "ANSWER_QUESTION", "HUMAN_HANDOFF"]).toContain(r.decision.action);
    expect(r.decision.product_ids).not.toContain("pro-kit");
    expect(r.decision.product_ids).not.toContain("vip-course-kit");
    expect(r.analysis.pain_points).toContain("lifting / retention");
  });

  it("3. 'course is too expensive' (unsure of value) -> explain value, no checkout push", async () => {
    const h = makeHarness();
    await h.dm("i'm a complete beginner, i want a side hustle from home");
    const { lead, result } = await h.dm("honestly that's a lot for an online course, is it worth it?");
    const r = done(result);
    expect(r.analysis.money_objection_type).toBe("unsure_of_value");
    expect(r.decision.action).toBe("ANSWER_QUESTION");
    expect(h.outboundText(lead.id)).not.toMatch(/if you really wanted|last chance|don't miss out/i);
  });

  it("4. lead who genuinely cannot afford it -> compassionate, no price, no link, no follow-up chase", async () => {
    const h = makeHarness();
    await h.dm("i'm a beginner and i'd love to do nails from home");
    const { lead, result } = await h.dm("i'm a single mum and money is really tight, i can't afford that right now");
    const r = done(result);
    expect(r.decision.action).toBe("NURTURE");
    const text = h.outboundText(lead.id);
    expect(text).not.toMatch(/\$|https?:/);
    expect(text).not.toMatch(/kids|children|deserve/i);
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(0);
  });

  it("5. lead asking for a payment plan -> plan from the product table, verbatim", async () => {
    const h = makeHarness();
    await h.dm("i'm a beginner wanting extra income");
    const { lead, result } = await h.dm("do you do payment plans?");
    const r = done(result);
    expect(r.decision.action).toBe("OFFER_PAYMENT_PLAN");
    expect(h.outboundText(lead.id)).toContain("9 weekly payments of $50");
  });

  it("6. beginner who needs a kit -> course + kit, no shipping promise (fulfilment not verified)", async () => {
    const h = makeHarness();
    await h.dm("i'm a complete beginner and starting from scratch, i want to do nails from home");
    const { lead, result } = await h.dm("what products do i need? i have no products at all");
    const r = done(result);
    expect(["RECOMMEND_COURSE_AND_KIT", "RECOMMEND_KIT"]).toContain(r.decision.action);
    expect(h.outboundText(lead.id)).not.toMatch(/ship|dispatch|business days/i);
  });

  it("7. experienced tech who does NOT need a kit -> kit removed even if suggested", async () => {
    const llm = new MockLLMProvider({ decision: { action: "RECOMMEND_COURSE_AND_KIT", product_ids: ["vip-course-kit"], confidence: 0.9 } });
    const h = makeHarness({ llm });
    await h.dm("i'm a nail tech with my own clients");
    const { result } = await h.dm("i already have all my products, i just want to get faster with my sets");
    const r = done(result);
    expect(r.decision.action).toBe("RECOMMEND_COURSE");
    expect(r.decision.product_ids).toEqual(["online-course"]);
  });

  it("8. hot lead asking how to pay -> checkout link (auto mode sends it)", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    await h.dm("i'm a beginner and want a side hustle");
    const { lead, result } = await h.dm("okay i'm ready, how do i pay? send me the link");
    const r = done(result);
    expect(r.decision.action).toBe("SEND_ENROLMENT_INFORMATION");
    expect(r.outcome).toBe("sent");
    expect(h.messaging.sent.map((s) => s.text).join(" ")).toContain(COURSE_URL);
    expect(h.repos.leads.get(lead.id)!.lead_temperature).toBe("very_hot");
  });

  it("8b. very hot lead on a high-ticket bundle -> handed to lee, nothing sent", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    await h.dm("complete beginner, i have no products at all");
    const { lead, result } = await h.dm("i want to join the vip one, how do i pay?");
    expect(result.status).toBe("done");
    const l = h.repos.leads.get(lead.id)!;
    expect(l.handoff_required).toBe(true);
    expect(l.handoff_priority).toBe("high");
    expect(h.messaging.sent.map((s) => s.text).join(" ")).not.toContain(BUNDLE_URL);
  });

  it("9. very hot lead wanting a call -> booking link when configured, handoff when not", async () => {
    const withLink = makeHarness({ settings: { DEFAULT_BOOKING_URL: BOOKING_URL } });
    await withLink.dm("i'm a beginner and keen to start");
    const a = await withLink.dm("can we jump on a call to chat about it?");
    expect(done(a.result).decision.action).toBe("OFFER_CALL");
    expect(withLink.outboundText(a.lead.id)).toContain(BOOKING_URL);

    const noLink = makeHarness();
    await noLink.dm("i'm a beginner and keen to start");
    const b = await noLink.dm("can we jump on a call to chat about it?");
    expect(done(b.result).decision.action).toBe("HUMAN_HANDOFF");
    expect(noLink.repos.leads.get(b.lead.id)!.handoff_required).toBe(true);
  });

  it("10. customer who already purchased -> follow-ups cancelled, never re-sold, new messages go to lee", async () => {
    const h = makeHarness();
    await h.dm("i'm a beginner wanting extra income");
    const first = await h.dm("i don't need a kit, just the course");
    const lead = first.lead;
    expect(h.repos.followUps.scheduledForLead(lead.id).length).toBeGreaterThanOrEqual(0);
    h.repos.leads.update(lead.id, { email: "student@example.com" });
    const res = recordPayment(h.agent.ctx, {
      provider: "kajabi",
      event_id: "purchase:abc",
      kind: "paid",
      transaction_id: "abc",
      amount: 450,
      currency: "AUD",
      email: "student@example.com",
      product_ref: { key: "kajabi_offer_id", value: "2151275161" },
      lead_ref: null,
      is_payment_plan: false,
      occurred_at: h.clock.now().toISOString(),
    });
    expect(res.status).toBe("recorded");
    const after = h.repos.leads.get(lead.id)!;
    expect(after.purchased).toBe(true);
    expect(after.automation_status).toBe("stopped");
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(0);

    const next = await h.dm("omg thank you! where do i find module 1?");
    expect(next.result.status).toBe("done");
    expect(h.repos.leads.get(lead.id)!.handoff_required).toBe(true);
    expect(h.drafts(lead.id)).toHaveLength(0);
  });

  it("11. customer says no -> one gracious closing message, automation stops", async () => {
    const h = makeHarness();
    await h.dm("i'm a beginner, just looking");
    const { lead, result } = await h.dm("no thanks, it's not for me");
    const r = done(result);
    expect(r.decision.action).toBe("MARK_NOT_INTERESTED");
    const l = h.repos.leads.get(lead.id)!;
    expect(l.automation_status).toBe("stopped");
    expect(l.status).toBe("not_interested");
    expect(h.outboundText(lead.id)).not.toMatch(/\$|https?:|\?/);
  });

  it("12. customer says stop messaging me -> nothing sent, ever", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    await h.dm("hi i'm a beginner");
    h.messaging.sent.length = 0;
    const { lead, result } = await h.dm("stop messaging me");
    const r = done(result);
    expect(r.decision.action).toBe("STOP_AUTOMATION");
    expect(h.messaging.sent).toHaveLength(0);
    const l = h.repos.leads.get(lead.id)!;
    expect(l.automation_status).toBe("stopped");
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(0);
    // even if she writes again, the AI doesn't reply automatically
    await h.dm("actually what was the price again?");
    expect(h.messaging.sent).toHaveLength(0);
    expect(h.repos.leads.get(lead.id)!.handoff_required).toBe(true);
  });

  it("13. angry / refund customer -> urgent handoff, no AI reply", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const { lead, result } = await h.dm("this is a scam, i want a refund now");
    const r = done(result);
    expect(r.decision.action).toBe("HUMAN_HANDOFF");
    const l = h.repos.leads.get(lead.id)!;
    expect(l.handoff_priority).toBe("urgent");
    expect(h.messaging.sent).toHaveLength(0);
    expect(h.repos.leads.unresolvedHandoffs().map((x) => x.id)).toContain(lead.id);
  });

  it("14. unclear pricing -> never guessed, handed off", async () => {
    const llm = new MockLLMProvider({ decision: { action: "RECOMMEND_COURSE", product_ids: ["mentorship"], confidence: 0.9 } });
    const h = makeHarness({ llm });
    const { lead, result } = await h.dm("i'm a nail tech and i'm interested in the mentorship, how much is it?");
    const r = done(result);
    expect(r.decision.action).toBe("HUMAN_HANDOFF");
    expect(r.decision.reason).toMatch(/pricing unknown/);
    expect(h.drafts(lead.id)).toHaveLength(0);
  });

  it("15. stock unavailable -> kit dropped (or handed off if she specifically wants it)", async () => {
    const h = makeHarness();
    h.repos.stock.upsert(
      { sku: "KIT-PRO", product_name: "Full Professional Kit", stock_quantity: 0, stock_status: "out_of_stock", fulfilment_days: 2, fulfilment_verified: true, shipping_enabled: true },
      h.clock.now().toISOString(),
    );
    await h.dm("i'm a complete beginner starting from scratch, i'd love a side hustle");
    const a = await h.dm("i have no products at all");
    const r = done(a.result);
    expect(r.decision.product_ids).not.toContain("vip-course-kit");
    expect(r.decision.product_ids).not.toContain("pro-kit");

    const h2 = makeHarness();
    h2.repos.stock.upsert(
      { sku: "KIT-PRO", product_name: "Full Professional Kit", stock_quantity: 0, stock_status: "out_of_stock", fulfilment_days: null, fulfilment_verified: false, shipping_enabled: false },
      h2.clock.now().toISOString(),
    );
    await h2.dm("i'm a complete beginner starting from scratch, i'd love a side hustle");
    const b = await h2.dm("i have no products, what kit do i need?");
    expect(done(b.result).decision.action).toBe("HUMAN_HANDOFF");
  });

  it("16. shipping fulfilment unknown -> shipping claims blocked; regenerate once, then handoff", async () => {
    const llm = new MockLLMProvider({
      decision: { action: "RECOMMEND_COURSE_AND_KIT", product_ids: ["vip-course-kit"], confidence: 0.9 },
      response: { messages: ["the kit ships within 2 business days babe xx"], claims_used: [] },
    });
    const h = makeHarness({ llm });
    const { lead, result } = await h.dm("i'm a complete beginner with no products, how fast would i get the kit?");
    expect(result.status).toBe("handoff");
    expect(h.drafts(lead.id)).toHaveLength(0);
    const safety = h.repos.audit.forLead(lead.id).filter((a) => a.stage === "safety");
    expect(safety).toHaveLength(2); // original + one regeneration
    expect(String(safety[0]!.data_json)).toContain("unverified_shipping");

    // once lee verifies fulfilment, the same claim is allowed
    const ok = new MockLLMProvider({
      decision: { action: "RECOMMEND_COURSE_AND_KIT", product_ids: ["vip-course-kit"], confidence: 0.9 },
      response: { messages: ["it's usually prepared and shipped about 2 business days after payment xx"], claims_used: [] },
    });
    const h2 = makeHarness({ llm: ok });
    h2.repos.stock.upsert(
      { sku: "KIT-PRO", product_name: "Full Professional Kit", stock_quantity: 5, stock_status: "in_stock", fulfilment_days: 2, fulfilment_verified: true, shipping_enabled: true },
      h2.clock.now().toISOString(),
    );
    const r2 = await h2.dm("i'm a complete beginner with no products, how fast would i get the kit?");
    expect(done(r2.result).outcome).toBe("draft_created");
  });

  it("17. human takeover -> AI records the conversation but never sends", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const first = await h.dm("hi i'm a beginner");
    h.agent.setTakeover(first.lead.id, true, "test");
    h.messaging.sent.length = 0;
    const { lead, result } = await h.dm("how do i pay? send me the link");
    expect(result.status).toBe("human_takeover");
    expect(h.messaging.sent).toHaveLength(0);
    expect(h.repos.leads.get(lead.id)!.lead_temperature).toBe("very_hot"); // CRM still updated

    // Lee replying from the Instagram app also pauses the AI automatically
    const h2 = makeHarness({ settings: { SEND_MODE: "auto" } });
    const x = await h2.dm("hi i'm a beginner");
    h2.agent.ingestEcho({ platform: "instagram", platform_user_id: "ig_123", platform_message_id: "lee_typed_1", text: "hey babe it's lee!", sent_at: h2.clock.now().toISOString() });
    expect(h2.repos.leads.get(x.lead.id)!.human_takeover).toBe(true);
  });

  it("18. duplicate webhook -> stored and processed once", async () => {
    const h = makeHarness();
    const evt = { platform: "instagram", platform_user_id: "ig_9", platform_message_id: "mid_dup", text: "hi! i'm a beginner", sent_at: h.clock.now().toISOString() };
    const a = h.agent.ingestInbound(evt);
    const b = h.agent.ingestInbound(evt);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    const lead = h.repos.leads.findByPlatformUser("instagram", "ig_9")!;
    expect(h.repos.messages.forLead(lead.id)).toHaveLength(1);
    h.clock.advanceMinutes(2);
    const [r1, r2] = await Promise.all([h.agent.processLead(lead.id), h.agent.processLead(lead.id)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["done", "locked"]);
    expect(new Set(h.repos.outbound.forLead(lead.id).map((o) => o.batch_id)).size).toBe(1);
    expect((await h.agent.processLead(lead.id)).status).toBe("nothing_to_do");

    // duplicate payment webhook
    const pay = { provider: "stripe" as const, event_id: "evt_1", kind: "paid" as const, transaction_id: "pi_1", amount: 450, currency: "AUD", email: null, product_ref: null, lead_ref: { lead_id: lead.id }, is_payment_plan: false, occurred_at: h.clock.now().toISOString() };
    expect(recordPayment(h.agent.ctx, pay).status).toBe("recorded");
    expect(recordPayment(h.agent.ctx, pay).status).toBe("duplicate");
    expect(h.repos.purchases.forLead(lead.id)).toHaveLength(1);
  });
});

describe("lee's business rules (from the 5 Oct handover)", () => {
  it("nail appointment requests go to lee, never a sales reply", async () => {
    const h = makeHarness();
    const { lead, result } = await h.dm("hi! do you have any availability for a set this saturday?");
    expect(done(result).decision.action).toBe("HUMAN_HANDOFF");
    expect(h.repos.leads.get(lead.id)!.handoff_reason).toMatch(/appointment/);
    expect(h.drafts(lead.id)).toHaveLength(0);
  });

  it("possible under-18s are never sold to", async () => {
    const h = makeHarness();
    const { lead, result } = await h.dm("hi i'm 16 and in year 11, how much is the course?");
    expect(done(result).decision.action).toBe("HUMAN_HANDOFF");
    expect(h.repos.leads.get(lead.id)!.handoff_reason).toMatch(/under 18/);
  });

  it("1:1 / in-person enquiries go to lee (1:1 full until 2027)", async () => {
    const h = makeHarness();
    const { lead, result } = await h.dm("do you do 1:1 in person training?");
    expect(done(result).decision.action).toBe("HUMAN_HANDOFF");
    expect(h.repos.leads.get(lead.id)!.handoff_priority).toBe("high");
  });

  it("a lead who can't afford it can be pointed to the free preview (with its link)", async () => {
    const llm = new MockLLMProvider({ decision: { action: "NURTURE", product_ids: ["free-preview"], confidence: 0.9 } });
    const h = makeHarness({ llm });
    h.repos.products.upsert(
      { id: "free-preview", name: "the free preview", type: "free", active: true, price: 0, currency: "AUD", payment_plan_available: false, payment_plan_description: null, includes: ["the first modules"], excludes: [], checkout_url: "https://www.lyora.com.au/offers/BLwddLaS/checkout", payment_plan_checkout_url: null, booking_url: null, stock_required: false, sku: null, external_ids: {}, notes: null },
      h.clock.now().toISOString(),
    );
    const { lead, result } = await h.dm("i'm a beginner but money is really tight right now, i can't afford it");
    const r = done(result);
    expect(r.decision.product_ids).toEqual(["free-preview"]);
    const draft = h.repos.audit.forLead(lead.id).find((a) => a.event === "draft_attempt_1");
    expect(String(draft!.data_json)).toContain("completely free, no card needed");
    expect(String(draft!.data_json)).toContain("BLwddLaS");
  });

  it("brand facts reach the writer and their amounts pass the safety check", async () => {
    const llm = new MockLLMProvider({ response: { messages: ["honestly i wasted about $2,000 on the wrong products when i started"], claims_used: [] } });
    const h = makeHarness({ llm });
    h.repos.brandFacts.replaceAll([{ id: "b2", text: "lee wasted about $2,000 on the wrong products before her first paying client" }], h.clock.now().toISOString());
    const { result } = await h.dm("i'm a complete beginner, what should i buy first?");
    expect(done(result).outcome).toBe("draft_created");
  });

  it("em dashes are removed and impersonation claims are blocked", async () => {
    const { cleanBubble } = await import("../src/pipeline/compose.js");
    expect(cleanBubble("honestly — it's so common")).toBe("honestly, it's so common");
    const llm = new MockLLMProvider({ response: { messages: ["it's really me, i answer every one myself xx"], claims_used: [] } });
    const h = makeHarness({ llm });
    const { result } = await h.dm("hi is the course good for beginners?");
    expect(result.status).toBe("handoff");
  });
});
