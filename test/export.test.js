import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";
import request from "supertest";
import { signExport, normalizeExport } from "../src/export.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { Scheduler } from "../src/queue.js";

const row = () => ({
  meterId: "J1",
  serialNo: "SER",
  make: "L&T",
  phaseType: "single",
  installStatus: "Faulty",
  installType: "CT Operated",
  build: "v2",
  dtCode: "DT-007",
  hierarchy: Object.fromEntries(
    [
      "zone",
      "circle",
      "division",
      "subdivision",
      "substation",
      "feeder",
      "dt",
    ].map((key) => [
      key,
      {
        name: key === "dt" ? "Old Malviya Nagar Xfmr" : key,
        code: key === "dt" ? "DT-007" : key.toUpperCase(),
      },
    ]),
  ),
  geo: { lat: 26.5, lng: 75.2 },
});
const payload = () => ({ data: [row()], total: 1 });
const is502 = (error) => error.status === 502;

test("export signing matches an independently calculated UTF-8 vector", () => {
  assert.deepEqual(signExport("fixture-secret-ü", 1700000000999), {
    "x-timestamp": "1700000000",
    "x-signature":
      "1de8631bdf9ec5c087acf20df14aa8b41a195d085d7b2c4bd204741a966faf67",
  });
});

test("normalization preserves names and coordinates, omits build, and identifies warning rows", () => {
  const result = normalizeExport(payload());
  assert.equal(result.data[0].installation_status, "faulty");
  assert.equal(result.data[0].manufacturer, "L&T");
  assert.equal(result.data[0].build, undefined);
  assert.deepEqual(result.data[0].hierarchy.transformer, {
    name: "Old Malviya Nagar Xfmr",
    code: "DT-007",
  });
  const source = payload();
  source.data[0].phaseType = "future-phase";
  source.data[0].geo = null;
  source.data[0].hierarchy.circle = null;
  const warned = normalizeExport(source);
  assert.equal(warned.data[0].phase_type, "unknown");
  assert.equal(warned.data[0].coordinates.latitude, null);
  assert.ok(warned.warnings.every((w) => w.field.startsWith("data.0.")));
  const missingName = payload();
  missingName.data[0].hierarchy.feeder.name = "";
  missingName.data[0].installType = "Whole Current";
  const named = normalizeExport(missingName);
  assert.deepEqual(named.data[0].hierarchy.feeder, {
    name: "",
    code: "FEEDER",
  });
  assert.equal(named.data[0].installation_type, "whole_current");
  const missingCode = payload();
  missingCode.data[0].hierarchy.circle.code = "";
  const preserved = normalizeExport(missingCode);
  assert.deepEqual(preserved.data[0].hierarchy.circle, {
    name: "circle",
    code: null,
  });
  assert.ok(
    preserved.warnings.some((w) => w.field === "data.0.hierarchy.circle"),
  );
  assert.deepEqual(normalizeExport({ data: [], total: 0 }).meta, {
    total: 0,
    returned_count: 0,
  });
});

test("export refuses incomplete, duplicate, conflicting, malformed and excessive datasets", () => {
  const invalid = [
    null,
    { data: [row()], total: 2 },
    { data: [row(), row()], total: 2 },
  ];
  for (const change of [
    (r) => {
      r.hierarchy.dt.code = "DT-999";
    },
    (r) => {
      r.geo.lat = 100;
    },
    (r) => {
      r.geo.lng = "75";
    },
    (r) => {
      delete r.serialNo;
    },
    (r) => {
      r.meterId = "../bad";
    },
  ]) {
    const source = payload();
    change(source.data[0]);
    invalid.push(source);
  }
  for (const source of invalid)
    assert.throws(() => normalizeExport(source), is502);
  assert.throws(
    () => normalizeExport({ data: Array(10001).fill(row()), total: 10001 }),
    { code: "PORTAL_EXPORT_TOO_LARGE" },
  );
});

async function fixture(t, options = {}) {
  const calls = [];
  let exports = 0;
  let now = 1700000000000;
  const secret = "fixture-signing-secret";
  const server = createServer((req, res) => {
    calls.push({
      path: req.url,
      cookie: req.headers.cookie,
      timestamp: req.headers["x-timestamp"],
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/portal/keys") {
      if (options.keyStatus) return res.writeHead(options.keyStatus).end("{}");
      if (options.rotate)
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=changed; Secure; Path=/`,
        );
      return res.end(
        options.rawKeys ?? JSON.stringify({ data: { signingSecret: secret } }),
      );
    }
    exports++;
    const expected = createHmac("sha256", secret)
      .update(`GET\n/portal/export\npage=1\n${req.headers["x-timestamp"]}`)
      .digest("hex");
    if (
      req.url !== "/portal/export?page=1" ||
      expected !== req.headers["x-signature"]
    )
      return res.writeHead(403).end("{}");
    if (options.retry && exports === 1) return res.writeHead(503).end("{}");
    if (options.status) return res.writeHead(options.status).end(secret);
    res.end(options.rawExport ?? JSON.stringify(options.payload ?? payload()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const scheduler = new Scheduler(1, 2);
  let checkAfterQueue = false;
  const portal = new PortalClient({
    origin: `http://127.0.0.1:${server.address().port}`,
    scheduler,
    now: () => {
      checkAfterQueue = scheduler.active === 1;
      return now;
    },
    sleep: async () => {
      now += 1000;
    },
    exportMaxBodyBytes: options.limit ?? 5 * 1024 * 1024,
  });
  let logs = "";
  const destination = new Writable({
    write(chunk, _encoding, cb) {
      logs += chunk;
      cb();
    },
  });
  const app = createApp({ portal, logger: createLogger("info", destination) });
  return { app, calls, afterQueue: () => checkAfterQueue, logs: () => logs };
}

test("export route signs after queue acquisition, regenerates retry timestamps and keeps caller cookie", async (t) => {
  const f = await fixture(t, { retry: true });
  const result = await request(f.app)
    .get("/api/v1/meters/export")
    .set("X-Urja-Session", "caller-secret")
    .expect(200);
  assert.equal(result.body.meta.returned_count, 1);
  assert.equal(result.body.data[0].meter_id, "J1");
  assert.equal(f.calls.length, 3);
  assert.ok(f.afterQueue());
  assert.notEqual(f.calls[1].timestamp, f.calls[2].timestamp);
  assert.ok(
    f.calls.every((call) => call.cookie === `${SESSION_COOKIE}=caller-secret`),
  );
  assert.equal(result.headers["cache-control"], "no-store");
  for (const secret of [
    "caller-secret",
    "fixture-signing-secret",
    "x-signature",
    "signingSecret",
  ])
    assert.ok(
      !f.logs().includes(secret) &&
        !JSON.stringify(result.body).includes(secret),
    );
});

test("export validates auth/query/method before invoking the portal", async (t) => {
  const f = await fixture(t);
  await request(f.app).get("/api/v1/meters/export").expect(401);
  await request(f.app)
    .get("/api/v1/meters/export?page=1")
    .set("X-Urja-Session", "caller-secret")
    .expect(400);
  const method = await request(f.app).post("/api/v1/meters/export").expect(405);
  assert.equal(method.headers.allow, "GET, HEAD");
  assert.equal(f.calls.length, 0);
});

test("key/export failures, session rotation and size limits produce no partial or secret response", async (t) => {
  for (const [options, status, code] of [
    [{ rawKeys: "{}" }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ rawKeys: "{bad" }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ keyStatus: 401 }, 401, "PORTAL_SESSION_INVALID"],
    [{ rotate: true }, 401, "PORTAL_SESSION_CHANGED"],
    [{ status: 403 }, 403, "FORBIDDEN"],
    [{ status: 401 }, 401, "PORTAL_SESSION_INVALID"],
    [{ rawExport: "{bad" }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ payload: { data: [row()], total: 2 } }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ limit: 10 }, 502, "PORTAL_RESPONSE_TOO_LARGE"],
  ]) {
    const f = await fixture(t, options);
    const response = await request(f.app)
      .get("/api/v1/meters/export")
      .set("X-Urja-Session", "caller-secret")
      .expect(status);
    assert.equal(response.body.error.code, code);
    assert.equal(response.body.data, undefined);
    if (options.rawKeys || options.keyStatus || options.rotate)
      assert.equal(f.calls.length, 1);
    for (const secret of ["caller-secret", "fixture-signing-secret"])
      assert.ok(
        !JSON.stringify(response.body).includes(secret) &&
          !f.logs().includes(secret),
      );
  }
});
