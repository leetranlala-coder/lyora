import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { StripePaymentProvider } from "../src/integrations/payments/stripe.js";
import { SquarePaymentProvider } from "../src/integrations/payments/square.js";
import { KajabiPaymentProvider } from "../src/integrations/payments/kajabi.js";
import { CalendlyBookingProvider } from "../src/integrations/booking/provider.js";
import { MetaInstagramProvider } from "../src/integrations/messaging/meta.js";
import { ManyChatProvider } from "../src/integrations/messaging/manychat.js";
import { WebhookAuthError } from "../src/integrations/messaging/provider.js";
import { detectSignals } from "../src/agents/signals.js";
import { scoreLead } from "../src/agents/scoring.js";
import { MockLLMProvider } from "../src/llm/mock.js";
import { makeHarness } from "./helpers.js";
import { recordBooking } from "../src/pipeline/outcomes.js";

const hex = (k: string, p: string) => createHmac("sha256", k).update(p).digest("hex");

describe("webhook signature verification", () => {
  it("stripe: accepts valid, rejects tampered and stale", async () => {
    const now = 1_790_000_000_000;
    const p = new StripePaymentProvider("whsec_test", 300, () => now);
    const body = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      created: now / 1000,
      data: { object: { payment_intent: "pi_1", amount_total: 45000, currency: "aud", payment_status: "paid", customer_details: { email: "a@b.com" }, metadata: { product_id: "online-course" } } },
    });
    const t = String(now / 1000);
    const ok = await p.handleWebhook({ "stripe-signature": `t=${t},v1=${hex("whsec_test", `${t}.${body}`)}` }, body);
    expect(ok[0]).toMatchObject({ kind: "paid", amount: 450, email: "a@b.com", product_ref: { key: "id", value: "online-course" } });
    await expect(p.handleWebhook({ "stripe-signature": `t=${t},v1=${hex("wrong", `${t}.${body}`)}` }, body)).rejects.toThrow(WebhookAuthError);
    const old = String(now / 1000 - 3600);
    await expect(p.handleWebhook({ "stripe-signature": `t=${old},v1=${hex("whsec_test", `${old}.${body}`)}` }, body)).rejects.toThrow(/tolerance/);
  });

  it("square: verifies url + body signature", async () => {
    const p = new SquarePaymentProvider("sqkey", "https://x.test/webhooks/square");
    const body = JSON.stringify({ event_id: "e1", type: "payment.updated", data: { object: { payment: { id: "p1", status: "COMPLETED", amount_money: { amount: 120000, currency: "AUD" }, note: "product:pro-kit" } } } });
    const sig = createHmac("sha256", "sqkey").update("https://x.test/webhooks/square" + body).digest("base64");
    const ev = await p.handleWebhook({ "x-square-hmacsha256-signature": sig }, body);
    expect(ev[0]).toMatchObject({ kind: "paid", amount: 1200, product_ref: { value: "pro-kit" } });
    await expect(p.handleWebhook({ "x-square-hmacsha256-signature": "nope" }, body)).rejects.toThrow(WebhookAuthError);
  });

  it("kajabi: shared secret + documented shape", async () => {
    const p = new KajabiPaymentProvider("kj");
    const body = JSON.stringify({ event: "purchase", id: "123", offer_id: "2151275161", amount: 450, email: "a@b.com", instagram: "@nailbabe" });
    const ev = await p.handleWebhook({ "x-lyora-secret": "kj" }, body);
    expect(ev[0]).toMatchObject({ kind: "paid", product_ref: { key: "kajabi_offer_id" }, lead_ref: { username: "nailbabe" } });
    await expect(p.handleWebhook({ "x-lyora-secret": "bad" }, body)).rejects.toThrow(WebhookAuthError);
  });

  it("calendly: signature + instagram handle from booking questions", async () => {
    const p = new CalendlyBookingProvider("ck");
    const body = JSON.stringify({ event: "invitee.created", payload: { uri: "inv_1", email: "a@b.com", questions_and_answers: [{ question: "Your Instagram handle?", answer: "@nailbabe" }] } });
    const ev = await p.handleBookingWebhook({ "calendly-webhook-signature": `t=1,v1=${hex("ck", `1.${body}`)}` }, body);
    expect(ev[0]).toMatchObject({ status: "booked", instagram: "nailbabe" });
  });

  it("meta: verifies X-Hub-Signature-256 and separates echoes", () => {
    const p = new MetaInstagramProvider({ appSecret: "app", accessToken: "t", igUserId: "1", graphBaseUrl: "https://graph.test" });
    const body = JSON.stringify({
      entry: [{ messaging: [
        { sender: { id: "lead1" }, recipient: { id: "biz" }, timestamp: 1, message: { mid: "m1", text: "hi" } },
        { sender: { id: "biz" }, recipient: { id: "lead1" }, timestamp: 2, message: { mid: "m2", text: "hey it's lee", is_echo: true } },
      ] }],
    });
    const parsed = p.parseWebhook({ "x-hub-signature-256": "sha256=" + hex("app", body) }, body);
    expect(parsed.inbound).toHaveLength(1);
    expect(parsed.echoes).toHaveLength(1);
    expect(() => p.parseWebhook({ "x-hub-signature-256": "sha256=bad" }, body)).toThrow(WebhookAuthError);
  });

  it("manychat: derives a stable message id when none is supplied", () => {
    const p = new ManyChatProvider({ apiKey: "k", webhookSecret: "s" });
    const body = JSON.stringify({ subscriber_id: "123", text: "hi", timestamp: "2026-10-06T02:00:10Z", username: "{{ig_username}}" });
    const a = p.parseWebhook({ "x-lyora-secret": "s" }, body);
    const b = p.parseWebhook({ "x-lyora-secret": "s" }, body);
    expect(a.inbound[0]!.platform_message_id).toBe(b.inbound[0]!.platform_message_id);
    expect(a.inbound[0]!.username).toBeNull(); // unfilled ManyChat placeholder ignored
  });
});

describe("lead scoring", () => {
  it("explicit buying intent sets a very-hot floor the model can't talk down", async () => {
    const llm = new MockLLMProvider({ analysis: { ai_score: 5 } });
    const a = (await llm.generateLeadAnalysis({ conversation: [], previous: null, purchasedProductNames: [] })).output;
    const s = scoreLead(detectSignals("how do i pay? send me the link"), a, 2, { hot: 51, veryHot: 76 });
    expect(s.temperature).toBe("very_hot");
    expect(s.final).toBeGreaterThanOrEqual(76);
  });
  it("vague curiosity stays cold, a 'no' is capped", async () => {
    const llm = new MockLLMProvider({ analysis: { ai_score: 10 } });
    const a = (await llm.generateLeadAnalysis({ conversation: [], previous: null, purchasedProductNames: [] })).output;
    expect(scoreLead(detectSignals("love your work"), a, 1, { hot: 51, veryHot: 76 }).temperature).toBe("cold");
    expect(scoreLead(detectSignals("how much is it? actually no thanks"), { ...a, ai_score: 90 }, 3, { hot: 51, veryHot: 76 }).final).toBeLessThanOrEqual(15);
  });
  it("doesn't mistake ordinary sentences for stop / discount requests", () => {
    expect(detectSignals("my sets don't stop lifting").askedToStop).toBe(false);
    expect(detectSignals("can i do it from home?").discountRequest).toBe(false);
    expect(detectSignals("please stop messaging me").askedToStop).toBe(true);
  });
});

describe("bookings", () => {
  it("a booked call stops nurture follow-ups", async () => {
    const h = makeHarness();
    await h.dm("i'm a beginner wanting extra income", "ig_1", "nailbabe");
    await h.dm("i don't want a kit, i already have products", "ig_1", "nailbabe");
    const lead = h.repos.leads.findByUsername("nailbabe")!;
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(1);
    const r = recordBooking(h.agent.ctx, { provider: "calendly", event_id: "e1", booking_id: "b1", status: "booked", email: null, instagram: "nailbabe", starts_at: null });
    expect(r.status).toBe("recorded");
    expect(h.repos.leads.get(lead.id)!.call_booked).toBe(true);
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(0);
  });
});
