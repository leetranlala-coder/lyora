import { createInterface } from "node:readline/promises";
import { buildConfig } from "../config.js";
import { buildApp } from "../app.js";
import { ManualScheduler } from "../scheduler/scheduler.js";
import { MockMessagingProvider } from "../integrations/messaging/mock.js";

/**
 * Chat with the agent in the terminal as if you were a lead.
 *   npm run simulate                 (mock LLM unless ANTHROPIC_API_KEY is set)
 * Uses a separate database (data/simulate.db) and shows each decision + the drafted reply.
 * Nothing is sent anywhere.
 */
const cfg = buildConfig({ ...process.env, DATABASE_PATH: process.env.SIM_DATABASE_PATH ?? "./data/simulate.db", SEND_MODE: "auto", MESSAGING_PROVIDER: "mock" });
const messaging = new MockMessagingProvider();
const app = buildApp({ cfg, scheduler: new ManualScheduler(), messaging });
(app.agent.ctx.cfg as { BUBBLE_DELAY_MS: number }).BUBBLE_DELAY_MS = 0;

const user = `sim_${Date.now()}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`\nLYORA simulator · llm=${app.cfg.LLM_PROVIDER} · active products=${app.repos.products.getActiveProducts().length}`);
if (!app.repos.products.getActiveProducts().length) console.log("(no active products — run `npm run seed` after activating some in config/products.json)");
console.log("type as the lead. /quit to exit.\n");

let n = 0;
for (;;) {
  const line = (await rl.question("lead > ")).trim();
  if (!line) continue;
  if (line === "/quit") break;
  app.agent.ingestInbound({ platform: "instagram", platform_user_id: user, platform_message_id: `${user}_${++n}`, text: line, sent_at: new Date().toISOString(), username: "simulated_lead" });
  const lead = app.repos.leads.findByPlatformUser("instagram", user)!;
  const before = messaging.sent.length;
  const r = await app.agent.processLead(lead.id, { ignoreQuietPeriod: true });
  const l = app.repos.leads.get(lead.id)!;
  if (r.status === "done") {
    console.log(`  · ${r.decision.action} — ${r.decision.reason}`);
    console.log(`  · ${l.lead_temperature} (${l.lead_score}) · ${r.outcome}`);
  } else console.log(`  · ${r.status}${"reason" in r ? ": " + r.reason : ""}`);
  if (l.handoff_required && !l.handoff_resolved_at) console.log(`  · handoff (${l.handoff_priority}): ${l.handoff_reason}`);
  for (const m of messaging.sent.slice(before)) console.log(`lee  > ${m.text}`);
}
rl.close();
app.scheduler.stop();
