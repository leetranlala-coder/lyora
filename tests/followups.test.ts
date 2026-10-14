import { describe, expect, it } from "vitest";
import { makeHarness } from "./helpers.js";
import { AdminActions } from "../src/pipeline/admin.js";

async function leadWithOffer(h: ReturnType<typeof makeHarness>) {
  await h.dm("i'm a beginner wanting extra income from home");
  const r = await h.dm("i don't want a kit, i already have a lamp and gels");
  return r.lead;
}

describe("follow-up engine", () => {
  it("schedules one follow-up after an offer, within send hours", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const lead = await leadWithOffer(h);
    const fus = h.repos.followUps.scheduledForLead(lead.id);
    expect(fus).toHaveLength(1);
    const perthHour = Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Perth", hour: "numeric", hourCycle: "h23" }).format(new Date(fus[0]!.scheduled_at)));
    expect(perthHour).toBeGreaterThanOrEqual(9);
    expect(perthHour).toBeLessThan(20);
    expect(fus[0]!.context).toContain("she last said");
  });

  it("cancels the follow-up when the lead replies", async () => {
    const h = makeHarness();
    const lead = await leadWithOffer(h);
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(1);
    await h.dm("ok thank you i'll have a think");
    const all = h.repos.followUps.forLead(lead.id);
    expect(all.some((f) => f.status === "cancelled" && f.status_reason === "lead replied")).toBe(true);
  });

  it("sends at most MAX_AUTOMATED_FOLLOWUPS and respects the 24h messaging window", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const lead = await leadWithOffer(h);
    h.messaging.sent.length = 0;

    h.clock.advanceHours(23); // 9:06am Perth next day: in send hours and inside the 24h window
    const first = await h.agent.runDueFollowUps();
    expect(first.sent).toBe(1);
    expect(h.messaging.sent).toHaveLength(1);
    expect(h.messaging.sent[0]!.text).not.toMatch(/just following up|just checking in/i);

    // second attempt would land outside Instagram's 24h window -> never auto-sent
    h.clock.advanceHours(30);
    await h.agent.runDueFollowUps();
    expect(h.messaging.sent).toHaveLength(1);
    const l = h.repos.leads.get(lead.id)!;
    expect(l.handoff_required).toBe(true);
    expect(l.handoff_priority).toBe("low");
    expect(l.handoff_reason).toMatch(/manual follow-up suggested/);

    h.clock.advanceHours(72);
    await h.agent.runDueFollowUps();
    expect(h.messaging.sent).toHaveLength(1);
    expect(h.repos.followUps.scheduledForLead(lead.id)).toHaveLength(0);
  });

  it("re-checks before sending: purchase / takeover cancel the follow-up", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const lead = await leadWithOffer(h);
    h.agent.setTakeover(lead.id, true, "test");
    h.clock.advanceHours(21);
    const r = await h.agent.runDueFollowUps();
    expect(r.sent).toBe(0);
    expect(h.repos.followUps.forLead(lead.id).every((f) => f.status !== "scheduled")).toBe(true);
  });

  it("in draft mode follow-ups become drafts and still count toward the limit", async () => {
    const h = makeHarness();
    const lead = await leadWithOffer(h);
    const admin = new AdminActions(h.agent);
    // a follow-up never fires while lee's reply is still waiting for approval
    h.clock.advanceHours(23);
    expect((await h.agent.runDueFollowUps()).drafted).toBe(0);

    const h2 = makeHarness();
    const lead2 = await leadWithOffer(h2);
    const batch = h2.drafts(lead2.id)[0]!.batch_id;
    await new AdminActions(h2.agent).approveDraft(batch);
    expect(h2.messaging.sent.length).toBeGreaterThan(0);
    const sentBefore = h2.messaging.sent.length;
    h2.clock.advanceHours(23);
    const r = await h2.agent.runDueFollowUps();
    expect(r.drafted).toBe(1);
    expect(h2.messaging.sent).toHaveLength(sentBefore);
    expect(h2.repos.followUps.countSentForLead(lead2.id)).toBe(1);
    void admin;
    void lead;
  });

  it("a discarded draft cancels its follow-up", async () => {
    const h = makeHarness();
    const lead = await leadWithOffer(h);
    new AdminActions(h.agent).discardDraft(h.drafts(lead.id)[0]!.batch_id);
    h.clock.advanceHours(23);
    await h.agent.runDueFollowUps();
    expect(h.repos.followUps.forLead(lead.id)[0]!.status).toBe("cancelled");
  });
});
