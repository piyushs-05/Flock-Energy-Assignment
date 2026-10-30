import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { Scheduler, operationFor, retryAfter } from "../src/queue.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";

const payload = { data: [], page: 1, pageSize: 20, total: 0 };
async function fixture(t, handler, options = {}) {
  let count = 0;
  const server = createServer((req, res) => handler(req, res, ++count));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const scheduler = options.scheduler || new Scheduler();
  const portal = new PortalClient({
    origin: `http://127.0.0.1:${server.address().port}`,
    sleep: async () => {},
    scheduler,
    ...options,
  });
  return { portal, scheduler, count: () => count };
}
const search = (portal, signal) =>
  portal.search("sentinel-session", { q: "", page: 1 }, signal);

test("slow body attempt times out, retries once, and compressed size is bounded after decoding", async (t) => {
  const slow = await fixture(
    t,
    (_req, res) => {
      res.writeHead(200);
      res.write("{");
    },
    { timeoutMs: 20 },
  );
  await assert.rejects(search(slow.portal), { code: "PORTAL_TIMEOUT" });
  assert.equal(slow.count(), 2);
  assert.equal(slow.scheduler.active, 0);
  const compressed = await fixture(
    t,
    (_req, res) => {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync("x".repeat(10000)));
    },
    { maxBodyBytes: 100 },
  );
  await assert.rejects(search(compressed.portal), {
    code: "PORTAL_RESPONSE_TOO_LARGE",
  });
  assert.equal(compressed.count(), 1);
});

test("total deadline expires while queued and permanent transport errors are never retried", async (t) => {
  const scheduler = new Scheduler(1, 1);
  const release = await scheduler.acquire();
  const f = await fixture(t, (_req, res) => res.end("{}"), { scheduler });
  const controller = new AbortController();
  operationFor(controller.signal, 20);
  await assert.rejects(search(f.portal, controller.signal), {
    code: "PORTAL_TIMEOUT",
  });
  assert.equal(f.count(), 0);
  assert.equal(scheduler.queue.length, 0);
  release();
  for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED"]) {
    let count = 0;
    const portal = new PortalClient({
      origin: "https://example.test",
      sleep: async () => {},
      adapter: async () => {
        count++;
        throw Object.assign(new Error("suppressed"), { code });
      },
    });
    await assert.rejects(search(portal), { code: "PORTAL_UNAVAILABLE" });
    assert.equal(count, 1);
  }
});

test("scheduler bounds active work and queue, preserves FIFO and releases once", async () => {
  const scheduler = new Scheduler(4, 2);
  const releases = await Promise.all(
    Array.from({ length: 4 }, () => scheduler.acquire()),
  );
  const order = [];
  const first = scheduler.acquire().then((release) => {
    order.push(1);
    return release;
  });
  const second = scheduler.acquire().then((release) => {
    order.push(2);
    return release;
  });
  await assert.rejects(scheduler.acquire(), { code: "SERVICE_BUSY" });
  assert.equal(scheduler.active, 4);
  assert.equal(scheduler.queue.length, 2);
  releases[0]();
  releases[0]();
  const releaseFirst = await first;
  assert.deepEqual(order, [1]);
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(order, [1, 2]);
  releaseSecond();
  releases.slice(1).forEach((release) => release());
  assert.equal(scheduler.active, 0);
  assert.equal(scheduler.queue.length, 0);
});

test("cancelled queued work is removed and never starts; active cancellation releases slot", async (t) => {
  const scheduler = new Scheduler(1, 1);
  const release = await scheduler.acquire();
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(payload)), {
    scheduler,
  });
  const controller = new AbortController();
  const pending = search(f.portal, controller.signal);
  await delay(10);
  controller.abort();
  await assert.rejects(pending, { code: "PORTAL_TIMEOUT" });
  assert.equal(f.count(), 0);
  assert.equal(scheduler.queue.length, 0);
  release();
  const hanging = await fixture(t, () => {});
  const active = new AbortController();
  const call = search(hanging.portal, active.signal);
  await delay(10);
  active.abort();
  await assert.rejects(call, { code: "PORTAL_TIMEOUT" });
  assert.equal(hanging.scheduler.active, 0);
});

test("read retries once; exhausted, forbidden, rate-limited and malformed responses do not amplify", async (t) => {
  const success = await fixture(t, (_req, res, n) =>
    n === 1 ? res.writeHead(503).end("{}") : res.end(JSON.stringify(payload)),
  );
  await search(success.portal);
  assert.equal(success.count(), 2);
  for (const [status, expected, attempts] of [
    [503, "PORTAL_UNAVAILABLE", 2],
    [401, "PORTAL_SESSION_INVALID", 1],
    [403, "FORBIDDEN", 1],
    [429, "PORTAL_RATE_LIMITED", 1],
  ]) {
    const f = await fixture(t, (_req, res) => res.writeHead(status).end("{}"));
    await assert.rejects(search(f.portal), { code: expected });
    assert.equal(f.count(), attempts);
    assert.equal(f.scheduler.active, 0);
  }
  const malformed = await fixture(t, (_req, res) => res.end("{bad"));
  await assert.rejects(search(malformed.portal), {
    code: "PORTAL_INVALID_RESPONSE",
  });
  assert.equal(malformed.count(), 1);
  const post = await fixture(t, (_req, res) => res.writeHead(503).end("{}"));
  await assert.rejects(
    post.portal.login({
      email: "test@example.com",
      password: "sentinel-password",
    }),
    { code: "PORTAL_UNAVAILABLE" },
  );
  assert.equal(post.count(), 1);
});

test("one retry budget and deadline are shared across multiple calls", async (t) => {
  const f = await fixture(t, (_req, res, n) =>
    n === 2 ? res.end(JSON.stringify(payload)) : res.writeHead(503).end("{}"),
  );
  const controller = new AbortController();
  operationFor(controller.signal, 1000);
  await search(f.portal, controller.signal);
  await assert.rejects(search(f.portal, controller.signal), {
    code: "PORTAL_UNAVAILABLE",
  });
  assert.equal(f.count(), 3);
  const short = new AbortController();
  operationFor(short.signal, 10);
  await assert.rejects(search(f.portal, short.signal), {
    code: "PORTAL_UNAVAILABLE",
  });
  assert.equal(f.count(), 4);
});

test("retry waits release capacity and abort stops retry delay", async (t) => {
  const scheduler = new Scheduler(1, 1);
  const controller = new AbortController();
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, (_req, res) => res.writeHead(503).end("{}"), {
    scheduler,
    sleep: async (_ms, signal) => {
      entered();
      await delay(10000, undefined, { signal });
    },
  });
  const pending = search(f.portal, controller.signal);
  await waiting;
  assert.equal(scheduler.active, 0);
  controller.abort();
  await assert.rejects(pending, { code: "PORTAL_TIMEOUT" });
  assert.equal(f.count(), 1);
});

test("real oversized and malformed bodies fail as 502 without retries; Retry-After is bounded", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("x".repeat(4096)), {
    maxBodyBytes: 100,
  });
  await assert.rejects(search(f.portal), {
    code: "PORTAL_RESPONSE_TOO_LARGE",
    status: 502,
  });
  assert.equal(f.count(), 1);
  const now = Date.UTC(2026, 9, 30);
  assert.equal(retryAfter("120", now), 60);
  assert.equal(retryAfter("0", now), 1);
  assert.equal(retryAfter(new Date(now + 5000).toUTCString(), now), 5);
  assert.equal(retryAfter("invalid", now), undefined);
  assert.equal(retryAfter("-1", now), undefined);
  const limited = await fixture(t, (_req, res) =>
    res.writeHead(429, { "Retry-After": "120" }).end("{}"),
  );
  const app = createApp({
    portal: limited.portal,
    logger: createLogger("silent"),
  });
  const result = await request(app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "sentinel-session")
    .expect(503);
  assert.equal(result.headers["retry-after"], "60");
  assert.equal(result.body.error.code, "PORTAL_RATE_LIMITED");
});

test("deleted/expired/replaced cookies reject sessions, while same-value renewal succeeds", async (t) => {
  for (const suffix of [
    "sentinel-session; Max-Age=0",
    "sentinel-session; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "changed",
  ]) {
    const f = await fixture(t, (_req, res) => {
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${suffix}; Path=/; Secure`,
      );
      res.end(JSON.stringify(payload));
    });
    await assert.rejects(search(f.portal), { code: "PORTAL_SESSION_CHANGED" });
    assert.equal(f.count(), 1);
  }
  const renewed = await fixture(t, (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=sentinel-session; Max-Age=3600; Path=/; Secure`,
    );
    res.end(JSON.stringify(payload));
  });
  await search(renewed.portal);
});

test("second-call session rejection yields no partial success and logs no upstream secrets", async (t) => {
  const { stringify } = await import("devalue");
  const fields = {
    MeterId: "J1",
    SerialNo: "SER",
    Make: "Genus",
    PhaseType: "single",
    InstallationStatus: "Installed",
    InstallationType: "CT Operated",
  };
  const detail = {
    type: "data",
    nodes: [
      {
        type: "data",
        data: JSON.parse(
          stringify({
            meterId: "J1",
            detail: { classData: JSON.stringify({ installed_meter: fields }) },
            hierarchy: {},
          }),
        ),
      },
    ],
  };
  const f = await fixture(t, (_req, res, n) =>
    n === 1
      ? res.end(JSON.stringify(detail))
      : res
          .writeHead(401)
          .end("sentinel-password signingSecret sentinel-signature"),
  );
  let logs = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk;
      callback();
    },
  });
  const app = createApp({
    portal: f.portal,
    logger: createLogger("info", destination),
  });
  const result = await request(app)
    .get("/api/v1/meters/J1/location")
    .set("X-Urja-Session", "sentinel-session")
    .expect(401);
  assert.equal(result.body.data, undefined);
  assert.equal(f.count(), 2);
  for (const secret of [
    "sentinel-password",
    "sentinel-session",
    "signingSecret",
    "sentinel-signature",
  ])
    assert.ok(
      !logs.includes(secret) && !JSON.stringify(result.body).includes(secret),
    );
});
