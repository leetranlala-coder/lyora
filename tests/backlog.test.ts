import { describe, expect, it } from "vitest";
import { makeHarness } from "./helpers.js";
import { importBacklogConversation, parseConversation } from "../src/pipeline/backlog.js";
import { AdminActions } from "../src/pipeline/admin.js";
import { sendBatch } from "../src/pipeline/sender.js";

describe("backlog (copy & send yourself)", () => {
  it("parses her:/me: labels, continuation lines and unlabeled pastes", () => {
    expect(parseConversation("her: hi!\nhow much is it?\nme: hi lovely\nher: ok")).toEqual([
      { direction: "inbound", content: "hi!\nhow much is it?" },
      { direction: "outbound", content: "hi lovely" },
      { direction: "inbound", content: "ok" },
    ]);
    expect(parseConversation("hiii - can i do it from home?")).toEqual([{ direction: "inbound", content: "hiii - can i do it from home?" }]);
    expect(parseConversation("@nailbabe: hello", "nailbabe")[0]).toEqual({ direction: "inbound", content: "hello" });
  });

  it("drafts a reply that is never sent automatically, even in auto mode", async () => {
    const h = makeHarness({ settings: { SEND_MODE: "auto" } });
    const r = await importBacklogConversation(h.agent, { handle: "@OldLead", text: "her: hi! i'm a complete beginner, how much is the course?" });
    expect(r.result.status).toBe("done");
    const drafts = h.repos.outbound.forLead(r.leadId);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.trigger === "manual" && d.status === "draft")).toBe(true);
    expect(h.messaging.sent).toHaveLength(0);
    expect((await sendBatch(h.agent.ctx, drafts[0]!.batch_id, "human")).status).toBe("blocked");
    expect(h.repos.followUps.scheduledForLead(r.leadId)).toHaveLength(0);
    // the 30-minute check never touches it
    h.clock.advanceHours(1);
    await h.agent.tick();
    expect(h.messaging.sent).toHaveLength(0);
  });

  it("'i've sent it' records lee's message; re-pasting the same chat adds nothing", async () => {
    const h = makeHarness();
    const r = await importBacklogConversation(h.agent, { handle: "oldlead", text: "her: hi! i'm a beginner wanting extra income" });
    const batch = h.repos.outbound.forLead(r.leadId)[0]!.batch_id;
    new AdminActions(h.agent).markCopiedDraftSent(batch, ["hi lovely, sorry only just seeing this xx"]);
    const msgs = h.repos.messages.forLead(r.leadId);
    expect(msgs.some((m) => m.human_generated && m.content.includes("only just seeing"))).toBe(true);
    const again = await importBacklogConversation(h.agent, { handle: "oldlead", text: "her: hi! i'm a beginner wanting extra income" });
    expect(again.added).toBe(0);
    expect(again.result.status).toBe("no_new_messages");
  });

  it("when she later DMs through ManyChat, the backlog lead becomes the live one", async () => {
    const h = makeHarness();
    const r = await importBacklogConversation(h.agent, { handle: "oldlead", text: "her: hi!" });
    h.agent.ingestInbound({ platform: "instagram", platform_user_id: "99887766", platform_message_id: "mc1", text: "hey again!", sent_at: h.clock.now().toISOString(), username: "OldLead" });
    const live = h.repos.leads.findByPlatformUser("instagram", "99887766")!;
    expect(live.id).toBe(r.leadId);
    expect(h.repos.messages.forLead(live.id).length).toBeGreaterThan(1);
  });

  it("sensitive messages still go to lee instead of getting a draft", async () => {
    const h = makeHarness();
    const r = await importBacklogConversation(h.agent, { handle: "angry1", text: "her: i want a refund, this is a scam" });
    expect(h.repos.outbound.forLead(r.leadId)).toHaveLength(0);
    expect(h.repos.leads.get(r.leadId)!.handoff_required).toBe(true);
  });
});
