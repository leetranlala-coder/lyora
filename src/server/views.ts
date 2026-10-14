import type { FollowUp, Lead, Message, OutboundMessage, Product, Purchase, StockItem } from "../domain/types.js";
import type { Metrics } from "../analytics/metrics.js";
import { esc } from "./http.js";
import { formatLocal } from "../util/time.js";

/** Server-rendered admin views. Plain HTML + a little CSS — nothing to build or maintain. */

const CSS = `
:root{--cream:#FAF6F1;--paper:#FFFDFB;--espresso:#3B2A22;--ink:#1C1512;--blush:#EFD9D2;--pink:#C99A9A;--muted:#8A7A72;--line:#E8DED7;--ok:#5E7A5E;--warn:#A86B4E;--bad:#9B3D3D}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--espresso);font:15px/1.55 "Inter",system-ui,-apple-system,sans-serif}
a{color:var(--espresso)}
header.top{display:flex;align-items:baseline;gap:28px;padding:22px 40px;border-bottom:1px solid var(--line);background:var(--paper);flex-wrap:wrap}
.brand{font-family:"Cormorant Garamond",Georgia,serif;font-size:26px;letter-spacing:.18em;color:var(--ink);text-decoration:none}
nav{display:flex;flex-wrap:wrap;gap:4px 18px}
nav a{text-decoration:none;font-size:13px;letter-spacing:.08em;text-transform:lowercase;color:var(--muted)}
nav a.on,nav a:hover{color:var(--ink)}
.mode{margin-left:auto;font-size:12px;letter-spacing:.06em;padding:4px 10px;border-radius:999px;background:var(--blush)}
.mode.auto{background:var(--espresso);color:var(--cream)}
main{max-width:1180px;margin:0 auto;padding:36px 40px 80px}
h1,h2,h3{font-family:"Cormorant Garamond",Georgia,serif;font-weight:500;color:var(--ink);letter-spacing:.01em}
h1{font-size:36px;margin:0 0 6px}h2{font-size:24px;margin:40px 0 14px}h3{font-size:19px;margin:22px 0 8px}
.sub{color:var(--muted);margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.stat b{display:block;font-family:"Cormorant Garamond",Georgia,serif;font-size:32px;font-weight:500;color:var(--ink)}
.stat span{font-size:12px;color:var(--muted);letter-spacing:.06em;text-transform:lowercase}
table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{font-weight:500;color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:lowercase}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;white-space:nowrap;padding:2px 9px;border-radius:999px;font-size:12px;background:var(--blush)}
.t-cold{background:#EEE9E4}.t-warm{background:#F4E3D3}.t-hot{background:#EFC9BE}.t-very_hot{background:var(--espresso);color:var(--cream)}
.p-urgent{background:var(--bad);color:#fff}.p-high{background:var(--warn);color:#fff}
.cols{display:grid;grid-template-columns:1.35fr 1fr;gap:28px}
.cols>div{min-width:0}
@media(max-width:900px){.cols{grid-template-columns:1fr}main,header.top{padding-left:16px;padding-right:16px}table{display:block;overflow-x:auto}.mode{margin-left:0}}
.card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin-bottom:18px}
.chat{display:flex;flex-direction:column;gap:6px}
.b{max-width:78%;padding:9px 13px;border-radius:18px;font-size:14px;white-space:pre-wrap}
.b.in{align-self:flex-start;background:#F1EBE6}
.b.out{align-self:flex-end;background:var(--blush)}
.b.human{align-self:flex-end;background:var(--espresso);color:var(--cream)}
.b small{display:block;font-size:11px;opacity:.6;margin-top:3px}
.draft{border:1px dashed var(--pink);border-radius:14px;padding:14px;margin-top:14px;background:#FFF8F6}
textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;background:#fff;resize:vertical}
input,select{border:1px solid var(--line);border-radius:10px;padding:7px 10px;font:inherit;background:#fff}
button,.btn{display:inline-block;border:1px solid var(--espresso);background:var(--espresso);color:var(--cream);border-radius:999px;padding:7px 16px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none;margin:4px 6px 4px 0}
button.ghost,.btn.ghost{background:transparent;color:var(--espresso)}
button.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
form.inline{display:inline}
dl{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;margin:0}
dt{color:var(--muted);font-size:13px}dd{margin:0}
.muted{color:var(--muted)}.small{font-size:12px}
.flash{background:var(--blush);padding:10px 14px;border-radius:12px;margin-bottom:18px}
details summary{cursor:pointer;color:var(--muted);font-size:13px}
pre{white-space:pre-wrap;font-size:12px;background:#F6F1EC;padding:10px;border-radius:10px;max-height:320px;overflow:auto}
`;

export function layout(title: string, active: string, body: string, opts: { mode: string; flash?: string } = { mode: "draft" }) {
  const link = (href: string, label: string) => `<a href="${href}" class="${active === label ? "on" : ""}">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · LYORA</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/admin">LYORA</a>
<nav>${link("/admin", "today")}${link("/admin/leads", "leads")}${link("/admin/drafts", "drafts")}${link("/admin/handoffs", "handoffs")}${link("/admin/analytics", "analytics")}${link("/admin/products", "products")}${link("/admin/purchases", "purchases")}</nav>
<span class="mode ${opts.mode === "auto" ? "auto" : ""}">${opts.mode === "auto" ? "auto send on" : "draft mode"}</span></header>
<main>${opts.flash ? `<div class="flash">${esc(opts.flash)}</div>` : ""}${body}</main></body></html>`;
}

const tz = { value: "Australia/Perth" };
export function setViewTimezone(t: string) {
  tz.value = t;
}
const when = (d: string | null | undefined) => formatLocal(d, tz.value);
const temp = (t: string) => `<span class="pill t-${esc(t)}">${esc(t.replace("_", " "))}</span>`;
const name = (l: Lead) => esc(l.display_name || (l.username ? "@" + l.username : l.platform_user_id));
const money = (n: number) => `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`;

export function todayPage(s: Record<string, number | string>, drafts: { lead: Lead; count: number; batch: string }[], handoffs: Lead[]) {
  const stat = (v: unknown, label: string) => `<div class="stat"><b>${esc(v)}</b><span>${label}</span></div>`;
  return `<h1>today</h1><p class="sub">perth time · since ${esc(when(String(s.from)))}</p>
<div class="grid">
${stat(s.new_leads, "new leads")}${stat(s.replies_sent, "replies sent")}${stat(s.drafts_waiting, "drafts waiting")}
${stat(s.cold, "cold")}${stat(s.warm, "warm")}${stat(s.hot, "hot")}${stat(s.very_hot, "very hot")}
${stat(s.open_handoffs, "handoffs open")}${stat(s.calls_booked, "calls booked")}${stat(s.purchases, "purchases")}
${stat(money(Number(s.revenue)), "revenue")}${stat(money(Number(s.ai_assisted_revenue)), "ai-assisted revenue")}${stat(s.follow_ups_due, "follow-ups next 24h")}
</div>
<h2>needs you</h2>
${handoffs.length ? leadTable(handoffs, true) : `<p class="muted">nothing waiting on you 🤍</p>`}
<h2>drafts to review</h2>
${drafts.length ? `<table><tr><th>lead</th><th>bubbles</th><th></th></tr>${drafts.map((d) => `<tr><td>${name(d.lead)}</td><td>${d.count}</td><td><a href="/admin/leads/${esc(d.lead.id)}#drafts">review</a></td></tr>`).join("")}</table>` : `<p class="muted">no drafts waiting</p>`}`;
}

export function leadTable(leads: Lead[], handoff = false) {
  return `<table><tr><th>lead</th><th>temp</th><th>score</th><th>status</th>${handoff ? "<th>why</th><th>priority</th>" : "<th>offer</th>"}<th>last message</th></tr>
${leads
  .map(
    (l) => `<tr><td><a href="/admin/leads/${esc(l.id)}">${name(l)}</a>${l.human_takeover ? ' <span class="pill">you</span>' : ""}</td>
<td>${temp(l.lead_temperature)}</td><td>${l.lead_score}</td><td>${esc(l.status)}${l.automation_status === "stopped" ? ' <span class="muted small">(ai stopped)</span>' : ""}</td>
${handoff ? `<td>${esc(l.handoff_reason)}</td><td><span class="pill p-${esc(l.handoff_priority)}">${esc(l.handoff_priority)}</span></td>` : `<td>${esc(l.recommended_offer ?? "")}</td>`}
<td class="muted">${esc(when(l.last_inbound_message_at))}</td></tr>`,
  )
  .join("")}</table>`;
}

export function leadsPage(leads: Lead[], q: string, t: string) {
  const opt = (v: string) => `<option value="${v}" ${t === v ? "selected" : ""}>${v || "all temperatures"}</option>`;
  return `<h1>leads</h1><form method="get" style="margin:0 0 18px"><input name="q" value="${esc(q)}" placeholder="search name / handle / email">
<select name="temp">${["", "cold", "warm", "hot", "very_hot"].map(opt).join("")}</select> <button class="ghost">filter</button></form>${leadTable(leads)}`;
}

export function leadPage(d: {
  lead: Lead;
  messages: Message[];
  drafts: OutboundMessage[][];
  followUps: FollowUp[];
  purchases: Purchase[];
  products: Product[];
  notes: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  bookingUrl: string | null;
}) {
  const l = d.lead;
  const post = (path: string, label: string, cls = "", confirm = "") =>
    `<form class="inline" method="post" action="/admin/leads/${esc(l.id)}/${path}"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ""}><button class="${cls}">${label}</button></form>`;
  const bubbles = d.messages
    .map((m) => {
      const cls = m.direction === "inbound" ? "in" : m.human_generated ? "human" : "out";
      const who = m.direction === "inbound" ? "" : m.human_generated ? "you · " : "ai · ";
      return `<div class="b ${cls}">${esc(m.content)}<small>${who}${esc(when(m.created_at))}</small></div>`;
    })
    .join("");
  const drafts = d.drafts
    .map((batch) => {
      const b = batch[0]!;
      return `<div class="draft"><div class="small muted">draft · ${esc(b.decision_action ?? "")} · ${esc(b.trigger)} · ${esc(when(b.created_at))}</div>
<form method="post" action="/admin/drafts/${esc(b.batch_id)}/approve">${batch
        .map((o) => `<textarea name="m" rows="2">${esc(o.content)}</textarea>`)
        .join("")}<div class="small muted">edit freely · clear a bubble to drop it</div><button>approve &amp; send</button></form>
<form class="inline" method="post" action="/admin/drafts/${esc(b.batch_id)}/discard"><button class="ghost">discard</button></form></div>`;
    })
    .join("");
  const a = l.analysis;
  return `<p class="small"><a href="/admin/leads">← leads</a></p>
<h1>${name(l)}</h1><p class="sub">${l.username ? "@" + esc(l.username) + " · " : ""}${esc(l.platform)} · ${temp(l.lead_temperature)} score ${l.lead_score} · ${esc(l.status)}</p>
<div class="card">
${l.human_takeover ? post("resume", "resume ai") : post("takeover", "take over", "", "pause the AI for this lead?")}
${post("not-interested", "mark not interested", "ghost", "stop all automated messages to this lead?")}
${post("call-booked", "mark call booked", "ghost")}
${l.handoff_required && !l.handoff_resolved_at ? post("resolve-handoff", "resolve handoff", "ghost") : ""}
${post("process", "run ai now", "ghost")}
${d.bookingUrl ? `<button class="ghost" onclick="navigator.clipboard.writeText('${esc(d.bookingUrl)}');this.textContent='copied ✓'">copy booking link</button>` : ""}
${l.human_takeover ? `<p class="small">you've taken over — the ai won't send anything to this lead.</p>` : ""}
${l.automation_status === "stopped" ? `<p class="small">automation stopped: ${esc(l.stop_reason)}</p>` : ""}
${l.handoff_required && !l.handoff_resolved_at ? `<p><span class="pill p-${esc(l.handoff_priority)}">${esc(l.handoff_priority)}</span> ${esc(l.handoff_reason)} <span class="muted small">since ${esc(when(l.handoff_created_at))}</span></p>` : ""}
</div>
<div class="cols"><div>
<div class="card"><h3>conversation</h3><div class="chat">${bubbles || '<p class="muted">no messages yet</p>'}</div><div id="drafts">${drafts}</div></div>
</div><div>
<div class="card"><h3>summary</h3><p>${esc(l.ai_summary ?? "—")}</p><dl>
<dt>experience</dt><dd>${esc(l.experience_level)}</dd>
<dt>goal</dt><dd>${esc(l.main_goal ?? "—")}</dd>
<dt>situation</dt><dd>${esc(a?.life_context || "—")}</dd>
<dt>pain points</dt><dd>${esc(l.pain_points.join(", ") || "—")}</dd>
<dt>objections</dt><dd>${esc(l.objections.join(", ") || "—")}${a?.money_objection_type && a.money_objection_type !== "none" && !l.objections.includes(a.money_objection_type.replace(/_/g, " ")) ? ` <span class="muted small">(${esc(a.money_objection_type.replace(/_/g, " "))})</span>` : ""}</dd>
<dt>products</dt><dd>${esc(a?.owns_products ?? "unknown")}${l.kit_needed ? " · kit could help" : ""}</dd>
<dt>recommended</dt><dd>${esc(l.recommended_offer ?? "—")}</dd>
<dt>email</dt><dd>${esc(l.email ?? "—")}</dd>
</dl></div>
<div class="card"><h3>follow-ups</h3>${
    d.followUps.length
      ? `<table>${d.followUps
          .map(
            (f) => `<tr><td>#${f.attempt_number} ${esc(when(f.scheduled_at))}<div class="small muted">${esc(f.status)}${f.status_reason ? " · " + esc(f.status_reason) : ""}</div></td><td>${
              f.status === "scheduled" ? `<form method="post" action="/admin/followups/${esc(f.id)}/cancel"><button class="ghost">cancel</button></form>` : ""
            }</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="muted">none</p>'
  }</div>
<div class="card"><h3>purchases</h3>${
    d.purchases.length
      ? d.purchases.map((p) => `<p>${money(p.amount)} · ${esc(p.product_id ?? "unknown product")} · ${esc(p.provider)} · ${esc(p.status)} <span class="muted small">${esc(when(p.purchased_at))}</span></p>`).join("")
      : '<p class="muted">none yet</p>'
  }
<form method="post" action="/admin/leads/${esc(l.id)}/purchased"><select name="product_id"><option value="">product…</option>${d.products
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.price ? " · " + money(p.price) : ""}</option>`)
    .join("")}</select> <input name="amount" placeholder="amount" size="7" inputmode="decimal"> <label class="small"><input type="checkbox" name="plan" value="1"> plan</label> <button class="ghost">mark purchased</button></form></div>
<div class="card"><h3>memory</h3>${
    d.notes.length ? `<dl>${d.notes.map((n) => `<dt>${esc(n.key)}</dt><dd>${esc(n.value)}</dd>`).join("")}</dl>` : '<p class="muted">nothing yet</p>'
  }</div>
<div class="card"><details><summary>audit trail (${d.audit.length})</summary>${d.audit
    .map(
      (e) =>
        `<p class="small"><b>${esc(e.stage)}</b> · ${esc(e.event)} · ${esc(e.actor)} · ${esc(when(String(e.created_at)))}${e.model ? ` · ${esc(e.model)} ${esc(e.prompt_name ?? "")}@${esc(e.prompt_version ?? "")}` : ""}</p>${
          e.data_json ? `<pre>${esc(JSON.stringify(JSON.parse(String(e.data_json)), null, 1))}</pre>` : ""
        }`,
    )
    .join("")}</details></div>
</div></div>`;
}

export function draftsPage(rows: { lead: Lead; batch: OutboundMessage[] }[]) {
  return `<h1>drafts</h1><p class="sub">replies the ai has written and is waiting for you to approve</p>${
    rows.length
      ? rows
          .map(
            ({ lead, batch }) => `<div class="card"><p><a href="/admin/leads/${esc(lead.id)}">${name(lead)}</a> ${temp(lead.lead_temperature)} <span class="muted small">${esc(batch[0]!.decision_action ?? "")} · ${esc(when(batch[0]!.created_at))}</span></p>
<div class="chat">${batch.map((o) => `<div class="b out">${esc(o.content)}</div>`).join("")}</div>
<p><a class="btn ghost" href="/admin/leads/${esc(lead.id)}#drafts">review in conversation</a></p></div>`,
          )
          .join("")
      : '<p class="muted">no drafts waiting 🤍</p>'
  }`;
}

export function handoffsPage(leads: Lead[]) {
  return `<h1>handoffs</h1><p class="sub">conversations the ai has stepped back from — most urgent first</p>${leads.length ? leadTable(leads, true) : '<p class="muted">nothing waiting on you 🤍</p>'}`;
}

export function analyticsPage(m: Metrics, days: number) {
  const row = (label: string, v: unknown) => `<tr><td>${label}</td><td>${esc(v)}</td></tr>`;
  return `<h1>analytics</h1><p class="sub">last ${days} days · <a href="?days=7">7</a> · <a href="?days=30">30</a> · <a href="?days=90">90</a></p>
<div class="cols"><table>
${row("leads", m.lead_count)}${row("responses sent", m.response_count)}${row("avg first response", m.average_first_response_minutes === null ? "—" : m.average_first_response_minutes + " min")}
${row("warm or hotter", m.warm_lead_rate + "%")}${row("hot or hotter", m.hot_lead_rate + "%")}${row("call booking rate", m.call_booking_rate + "%")}
${row("purchase conversion", m.purchase_conversion_rate + "%")}${row("handoff rate", m.handoff_rate + "%")}${row("follow-up → reply/purchase", m.follow_up_conversion_rate + "%")}
</table><table>
${row("course sales", m.course_sales)}${row("kit sales", m.kit_sales)}${row("course + kit sales", m.course_and_kit_sales)}${row("other sales", m.other_sales)}
${row("payment plan sales", m.payment_plan_sales)}${row("revenue", money(m.revenue))}
${row("ai-assisted revenue", money(m.ai_assisted_revenue))}${row("lee-assisted revenue", money(m.human_assisted_revenue))}${row("unattributed revenue", money(m.unattributed_revenue))}
${row("refunds / disputes", m.refunded_or_disputed)}
</table></div>
<p class="small muted">"ai-assisted" means the ai was talking to her before she bought and you weren't — it shows involvement, not that the ai caused the sale.</p>`;
}

export function productsPage(products: Product[], stock: StockItem[]) {
  return `<h1>products</h1><p class="sub">the ai can only sell <b>active</b> products with a known price. edit <code>config/products.json</code> then run <code>npm run seed</code>.</p>
<table><tr><th>product</th><th>type</th><th>price</th><th>payment plan</th><th>links</th><th>status</th></tr>${products
    .map((p) => {
      const issues = [!p.active && "inactive", p.active && p.price === null && "no price → handoff", p.active && !p.checkout_url && "no checkout link"].filter(Boolean);
      return `<tr><td>${esc(p.name)}<div class="small muted">${esc(p.id)}</div></td><td>${esc(p.type)}</td><td>${p.price === null ? "—" : money(p.price)}</td>
<td>${p.payment_plan_available ? esc(p.payment_plan_description) : "—"}</td><td class="small">${p.checkout_url ? "checkout ✓" : ""} ${p.booking_url ? "booking ✓" : ""}</td>
<td>${issues.length ? `<span class="small" style="color:var(--warn)">${esc(issues.join(" · "))}</span>` : '<span class="pill">sellable</span>'}</td></tr>`;
    })
    .join("")}</table>
<h2>kit stock</h2><table><tr><th>sku</th><th>stock</th><th>fulfilment</th><th>can the ai mention shipping?</th></tr>${stock
    .map(
      (s) => `<tr><td>${esc(s.sku)}</td><td>${esc(s.stock_status)}${s.stock_quantity !== null ? ` (${s.stock_quantity})` : ""}</td><td>${s.fulfilment_days ?? "—"} business days</td>
<td>${s.fulfilment_verified && s.shipping_enabled && s.fulfilment_days !== null ? "yes" : "no — not verified"}</td></tr>`,
    )
    .join("")}</table>`;
}

export function purchasesPage(unmatched: Purchase[], all: Purchase[], leads: Lead[]) {
  return `<h1>purchases</h1>
<h2>unmatched</h2>${
    unmatched.length
      ? `<table><tr><th>when</th><th>amount</th><th>email</th><th>provider</th><th>match to lead</th></tr>${unmatched
          .map(
            (p) => `<tr><td>${esc(when(p.purchased_at))}</td><td>${money(p.amount)}</td><td>${esc(p.customer_email ?? "—")}</td><td>${esc(p.provider)}</td>
<td><form method="post" action="/admin/purchases/${esc(p.id)}/match"><select name="lead_id">${leads
              .map((l) => `<option value="${esc(l.id)}">${name(l)}</option>`)
              .join("")}</select> <button class="ghost">match</button></form></td></tr>`,
          )
          .join("")}</table>`
      : '<p class="muted">all purchases are matched</p>'
  }
<h2>recent</h2><table><tr><th>when</th><th>amount</th><th>product</th><th>provider</th><th>status</th><th>attribution</th></tr>${all
    .slice(0, 100)
    .map(
      (p) =>
        `<tr><td>${esc(when(p.purchased_at))}</td><td>${money(p.amount)}${p.is_payment_plan ? ' <span class="small muted">plan</span>' : ""}</td><td>${esc(p.product_id ?? "—")}</td><td>${esc(p.provider)}</td><td>${esc(p.status)}</td><td class="small">${esc(p.attribution ?? "—")}</td></tr>`,
    )
    .join("")}</table>`;
}
