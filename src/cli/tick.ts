import { buildApp } from "../app.js";
import { ManualScheduler } from "../scheduler/scheduler.js";

/** Run the periodic safety check once (for external cron: `npm run tick`). */
const app = buildApp({ scheduler: new ManualScheduler() });
const summary = await app.agent.tick();
console.log(JSON.stringify(summary));
