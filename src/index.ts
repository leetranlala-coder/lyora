import { createServer } from "node:http";
import { buildApp } from "./app.js";
import { readRequest, text, writeResponse } from "./server/http.js";
import { log, setLogLevel } from "./logger.js";

const app = buildApp();
setLogLevel(app.cfg.LOG_LEVEL);

const server = createServer(async (req, res) => {
  try {
    const r = await readRequest(req);
    writeResponse(res, await app.router.handle(r));
  } catch (err) {
    log.error("request failed", { path: req.url, err });
    writeResponse(res, text("error", 500));
  }
});

server.listen(app.cfg.PORT, () => {
  log.info("LYORA DM agent listening", {
    port: app.cfg.PORT,
    sendMode: app.cfg.SEND_MODE,
    agentEnabled: app.cfg.AGENT_ENABLED,
    llm: app.cfg.LLM_PROVIDER,
    messaging: app.cfg.MESSAGING_PROVIDER,
    checkEveryMinutes: app.cfg.MESSAGE_CHECK_INTERVAL_MINUTES,
  });
  if (app.cfg.SEND_MODE === "draft") log.info("DRAFT MODE: replies are written for review and never sent automatically");
  if (!app.cfg.ADMIN_PASSWORD) log.warn("ADMIN_PASSWORD is not set — the admin dashboard is disabled");
});

const shutdown = () => {
  app.scheduler.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
