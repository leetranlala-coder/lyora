import type { Repos } from "../db/repositories.js";
import { startOfLocalDay } from "../util/time.js";

/**
 * Funnel metrics. Rates are simple ratios over leads created in the period.
 * Revenue attribution is descriptive (who was in the conversation before the sale),
 * never a claim that the AI caused the purchase.
 */

export interface Metrics {
  period: { from: string; to: string };
  lead_count: number;
  response_count: number;
  average_first_response_minutes: number | null;
  warm_lead_rate: number;
  hot_lead_rate: number;
  call_booking_rate: number;
  purchase_conversion_rate: number;
  handoff_rate: number;
  follow_up_conversion_rate: number;
  course_sales: number;
  kit_sales: number;
  course_and_kit_sales: number;
  other_sales: number;
  payment_plan_sales: number;
  revenue: number;
  ai_assisted_revenue: number;
  human_assisted_revenue: number;
  unattributed_revenue: number;
  refunded_or_disputed: number;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function computeMetrics(repos: Repos, fromIso: string, toIso: string): Metrics {
  const db = repos.db;
  const one = <T = number>(sql: string, ...p: (string | number)[]) => {
    const r = db.prepare(sql).get(...p) as Record<string, unknown> | undefined;
    return (r ? Object.values(r)[0] : 0) as T;
  };

  const leadCount = Number(one("SELECT COUNT(*) FROM leads WHERE created_at >= ? AND created_at < ?", fromIso, toIso));
  const inPeriod = "FROM leads WHERE created_at >= ? AND created_at < ?";
  const warmPlus = Number(one(`SELECT COUNT(*) ${inPeriod} AND lead_score >= 26`, fromIso, toIso));
  const hotPlus = Number(one(`SELECT COUNT(*) ${inPeriod} AND lead_score >= 51`, fromIso, toIso));
  const calls = Number(one(`SELECT COUNT(*) ${inPeriod} AND call_booked = 1`, fromIso, toIso));
  const bought = Number(one(`SELECT COUNT(*) ${inPeriod} AND purchased = 1`, fromIso, toIso));
  const handoffs = Number(one(`SELECT COUNT(*) ${inPeriod} AND handoff_created_at IS NOT NULL`, fromIso, toIso));

  const responses = Number(
    one("SELECT COUNT(*) FROM messages WHERE direction = 'outbound' AND created_at >= ? AND created_at < ?", fromIso, toIso),
  );
  const frt = db
    .prepare(
      `SELECT l.first_response_at AS fr, (SELECT MIN(created_at) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'inbound') AS fi
       ${inPeriod.replace("FROM leads", "FROM leads l")} AND l.first_response_at IS NOT NULL`,
    )
    .all(fromIso, toIso) as { fr: string; fi: string | null }[];
  const deltas = frt.filter((r) => r.fi).map((r) => (new Date(r.fr).getTime() - new Date(r.fi!).getTime()) / 60000).filter((m) => m >= 0);

  // follow-up conversion: leads that got a follow-up (sent) and later replied or purchased
  const fuLeads = db
    .prepare("SELECT lead_id, MIN(updated_at) AS at FROM follow_ups WHERE status = 'sent' AND updated_at >= ? AND updated_at < ? GROUP BY lead_id")
    .all(fromIso, toIso) as { lead_id: string; at: string }[];
  const fuConverted = fuLeads.filter((f) => {
    const replied = db.prepare("SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'inbound' AND created_at > ?").get(f.lead_id, f.at);
    const paid = db.prepare("SELECT 1 FROM purchases WHERE lead_id = ? AND purchased_at > ? AND status = 'paid'").get(f.lead_id, f.at);
    return !!(replied || paid);
  }).length;

  const purchases = db
    .prepare(
      `SELECT p.amount, p.status, p.is_payment_plan, p.attribution, pr.type AS product_type
       FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
       WHERE p.purchased_at >= ? AND p.purchased_at < ?`,
    )
    .all(fromIso, toIso) as { amount: number; status: string; is_payment_plan: number; attribution: string | null; product_type: string | null }[];
  const paid = purchases.filter((p) => p.status === "paid");
  const sum = (xs: typeof paid) => Math.round(xs.reduce((a, p) => a + Number(p.amount), 0) * 100) / 100;

  return {
    period: { from: fromIso, to: toIso },
    lead_count: leadCount,
    response_count: responses,
    average_first_response_minutes: deltas.length ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : null,
    warm_lead_rate: pct(warmPlus, leadCount),
    hot_lead_rate: pct(hotPlus, leadCount),
    call_booking_rate: pct(calls, leadCount),
    purchase_conversion_rate: pct(bought, leadCount),
    handoff_rate: pct(handoffs, leadCount),
    follow_up_conversion_rate: pct(fuConverted, fuLeads.length),
    course_sales: paid.filter((p) => p.product_type === "course").length,
    kit_sales: paid.filter((p) => p.product_type === "kit").length,
    course_and_kit_sales: paid.filter((p) => p.product_type === "course_and_kit").length,
    other_sales: paid.filter((p) => !["course", "kit", "course_and_kit"].includes(p.product_type ?? "")).length,
    payment_plan_sales: paid.filter((p) => p.is_payment_plan).length,
    revenue: sum(paid),
    ai_assisted_revenue: sum(paid.filter((p) => p.attribution === "ai_assisted")),
    human_assisted_revenue: sum(paid.filter((p) => p.attribution === "human_assisted")),
    unattributed_revenue: sum(paid.filter((p) => !p.attribution || p.attribution === "unattributed")),
    refunded_or_disputed: purchases.filter((p) => p.status === "refunded" || p.status === "disputed").length,
  };
}

/** "Today" counters for the dashboard home, in the business timezone. */
export function todaySummary(repos: Repos, now: Date, timeZone: string) {
  const from = startOfLocalDay(now, timeZone).toISOString();
  const to = new Date(now.getTime() + 1000).toISOString();
  const db = repos.db;
  const count = (sql: string, ...p: string[]) => Number(Object.values(db.prepare(sql).get(...p) as object)[0]);
  const byTemp = (t: string) => count("SELECT COUNT(*) FROM leads WHERE lead_temperature = ? AND last_inbound_message_at >= ?", t, from);
  return {
    from,
    new_leads: count("SELECT COUNT(*) FROM leads WHERE created_at >= ?", from),
    replies_sent: count("SELECT COUNT(*) FROM messages WHERE direction = 'outbound' AND ai_generated = 1 AND created_at >= ?", from),
    drafts_waiting: count("SELECT COUNT(DISTINCT batch_id) FROM outbound_messages WHERE status = 'draft'"),
    cold: byTemp("cold"),
    warm: byTemp("warm"),
    hot: byTemp("hot"),
    very_hot: byTemp("very_hot"),
    open_handoffs: count("SELECT COUNT(*) FROM leads WHERE handoff_required = 1 AND handoff_resolved_at IS NULL"),
    calls_booked: count("SELECT COUNT(*) FROM bookings WHERE status = 'booked' AND created_at >= ?", from),
    purchases: count("SELECT COUNT(*) FROM purchases WHERE status = 'paid' AND purchased_at >= ?", from),
    revenue: Number((db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM purchases WHERE status = 'paid' AND purchased_at >= ?").get(from) as { v: number }).v),
    ai_assisted_revenue: Number(
      (db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM purchases WHERE status = 'paid' AND attribution = 'ai_assisted' AND purchased_at >= ?").get(from) as { v: number }).v,
    ),
    follow_ups_due: count("SELECT COUNT(*) FROM follow_ups WHERE status = 'scheduled' AND scheduled_at <= ?", new Date(now.getTime() + 24 * 3600_000).toISOString()),
  };
}
