import type { FollowUp, Lead } from "../domain/types.js";
import { addHours, hoursBetween, localHour, nextTimeInWindow } from "../util/time.js";
import type { AgentContext } from "./context.js";
import { pendingOutbound } from "./sender.js";

/**
 * Follow-up engine. Follow-ups are rare, capped, and re-checked right before they run.
 *
 * Instagram's messaging policy only allows automated messages within MESSAGING_WINDOW_HOURS (24h)
 * of the lead's last message. Follow-ups that would land outside the window are never sent
 * automatically — they become a low-priority "manual follow-up suggested" item for Lee.
 */

export function scheduleFollowUp(
  ctx: AgentContext,
  lead: Lead,
  input: { reason: string; context: string; hours?: number | null },
): FollowUp | null {
  const { repos, cfg } = ctx;
  const now = ctx.clock.now();
  const sent = repos.followUps.countSentForLead(lead.id);
  const scheduled = repos.followUps.scheduledForLead(lead.id);
  if (scheduled.length) return null; // one at a time
  if (sent >= cfg.MAX_AUTOMATED_FOLLOWUPS) return null;
  if (lead.automation_status === "stopped" || lead.human_takeover || lead.purchased || lead.call_booked) return null;

  let at = addHours(now, input.hours ?? cfg.FOLLOWUP_INTERVAL_HOURS);
  const lastSent = repos.followUps
    .forLead(lead.id)
    .filter((f) => f.status === "sent" || f.status === "completed")
    .map((f) => f.updated_at)
    .sort()
    .pop();
  if (lastSent) {
    const earliest = addHours(new Date(lastSent), cfg.MINIMUM_HOURS_BETWEEN_FOLLOWUPS);
    if (at < earliest) at = earliest;
  }
  at = nextTimeInWindow(at, cfg.BUSINESS_TIMEZONE, cfg.FOLLOWUP_SEND_START_HOUR, cfg.FOLLOWUP_SEND_END_HOUR);

  // Try to land inside the platform messaging window.
  if (lead.last_inbound_message_at) {
    const deadline = addHours(new Date(lead.last_inbound_message_at), cfg.MESSAGING_WINDOW_HOURS - 1);
    if (at > deadline && deadline.getTime() - now.getTime() > 2 * 3_600_000) {
      const h = localHour(deadline, cfg.BUSINESS_TIMEZONE);
      if (h >= cfg.FOLLOWUP_SEND_START_HOUR && h < cfg.FOLLOWUP_SEND_END_HOUR) at = deadline;
    }
  }

  const fu = repos.followUps.schedule({
    lead_id: lead.id,
    scheduled_at: at.toISOString(),
    reason: input.reason,
    context: input.context,
    attempt_number: sent + 1,
    now: now.toISOString(),
  });
  repos.leads.update(lead.id, { follow_up_due_at: fu.scheduled_at, updated_at: now.toISOString() });
  repos.audit.write({ lead_id: lead.id, stage: "followup", event: "scheduled", data: fu, now: now.toISOString() });
  return fu;
}

/** Why a due follow-up must not run (null = ok to run). */
export function followUpBlocker(ctx: AgentContext, lead: Lead, fu: FollowUp): { reason: string; status: "cancelled" | "skipped" } | null {
  const c = (reason: string) => ({ reason, status: "cancelled" as const });
  if (lead.last_inbound_message_at && lead.last_inbound_message_at > fu.created_at) return c("lead replied");
  if (lead.purchased) return c("lead purchased");
  if (lead.call_booked) return c("call booked");
  if (lead.automation_status === "stopped") return c(`automation stopped (${lead.stop_reason ?? ""})`);
  if (lead.human_takeover) return c("human takeover");
  if (lead.handoff_required && !lead.handoff_resolved_at) return c("handoff open");
  if (ctx.repos.followUps.countSentForLead(lead.id) >= ctx.cfg.MAX_AUTOMATED_FOLLOWUPS) return c("max automated follow-ups reached");
  if (pendingOutbound(ctx, lead.id).length) return { reason: "another message is already pending", status: "skipped" };
  if (!lead.last_outbound_message_at || (lead.last_inbound_message_at && lead.last_outbound_message_at < lead.last_inbound_message_at)) {
    return c("our last reply was never sent — nothing to follow up on");
  }
  if (!ctx.cfg.AGENT_ENABLED) return { reason: "agent disabled", status: "skipped" };
  return null;
}

export function outsideMessagingWindow(ctx: AgentContext, lead: Lead): boolean {
  return !lead.last_inbound_message_at || hoursBetween(lead.last_inbound_message_at, ctx.clock.now()) > ctx.cfg.MESSAGING_WINDOW_HOURS - 0.25;
}

export function inSendHours(ctx: AgentContext): boolean {
  const h = localHour(ctx.clock.now(), ctx.cfg.BUSINESS_TIMEZONE);
  return h >= ctx.cfg.FOLLOWUP_SEND_START_HOUR && h < ctx.cfg.FOLLOWUP_SEND_END_HOUR;
}
