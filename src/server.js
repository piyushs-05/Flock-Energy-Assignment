import { readConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PortalClient } from "./portal.js";
import { createApp } from "./app.js";

import { Scheduler } from "./queue.js";

const config = readConfig();
const logger = createLogger(config.LOG_LEVEL);
const portal = new PortalClient({
  origin: config.PORTAL_ORIGIN,
  timeoutMs: config.PORTAL_TIMEOUT_MS,
  scheduler: new Scheduler(
    config.PORTAL_MAX_CONCURRENCY,
    config.PORTAL_MAX_QUEUE,
  ),
});
const server = createApp({
  portal,
  logger,
  timeoutMs: config.REQUEST_TIMEOUT_MS,
}).listen(config.PORT, config.HOST, () =>
  logger.info(
    { host: config.HOST, port: config.PORT },
    "Urja Meter API listening",
  ),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
