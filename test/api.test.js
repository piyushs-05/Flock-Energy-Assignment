import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";
import { createLogger } from "../src/logger.js";
import { readConfig } from "../src/config.js";

const payload = {
  data: [
    {
      meterId: "J100007",
      serialNo: "SE11409",
      make: "L&T",
      phaseType: "single",
      installStatus: "Decommissioned",
      dtCode: "DT-008",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

async function fixture(t, options = {}) {
  const seen = [];
  let revoked = false;
  const upstream = createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
    if (options.delay)
      await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (req.url === "/login") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get("password") !== "test-password") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            type: "failure",
            status: 401,
            data: "Invalid email or password.",
          }),
        );
        return;
      }
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=test-session; Path=/; Secure; HttpOnly; Max-Age=3600`,
      );
      res.end("Logged in");
      return;
    }
    if (req.url === "/api/auth/sign-out") {
      if (
        revoked ||
        !req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`)
      ) {
        res.writeHead(401).end("{}");
        return;
      }
      revoked = true;
      res.setHeader("Content-Type", "application/json");
      if (options.logoutClears !== false)
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; Max-Age=0`,
        );
      res.end(options.logoutRaw ?? JSON.stringify({ success: true }));
      return;
    }
    if (
      revoked ||
      (!req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`) &&
        !req.headers.cookie?.includes(`${SESSION_COOKIE}=other-session`))
    ) {
      res.writeHead(401).end("{}");
      return;
    }
    if (options.status) {
      res.writeHead(options.status).end("{}");
      return;
    }
    if (options.rotation)
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=changed; Path=/`);
    res.setHeader("Content-Type", "application/json");
    res.end(options.raw ?? JSON.stringify(options.payload ?? payload));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  // test mock is HTTP; real config requires HTTPS
  const portal = new PortalClient({
    origin: `http://127.0.0.1:${upstream.address().port}`,
    timeoutMs: options.timeoutMs ?? 1000,
  });
  let logs = "";
  const destination = new Writable({
    write(chunk, encoding, callback) {
      logs += chunk;
      callback();
    },
  });
  const app = createApp({
    portal,
    logger: createLogger("info", destination),
    timeoutMs: options.timeoutMs ?? 1000,
    loginLimit: options.loginLimit ?? 50,
  });
  return { app, seen, logs: () => logs };
}

test("login returns a cookie verified with an independent search; protected search normalizes data", async (t) => {
  const { app, seen, logs } = await fixture(t);
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "test@example.com", password: "test-password" })
    .expect(200);
  assert.equal(login.body.data.session_token, "test-session");
  assert.ok(Date.parse(login.body.data.expires_at) > Date.now());
  assert.equal(login.headers["cache-control"], "no-store");
  const result = await request(app)
    .get("/api/v1/meters?q=J100007&page=1")
    .set("X-Urja-Session", login.body.data.session_token)
    .expect(200);
  assert.equal(result.body.data[0].installation_status, "decommissioned");
  assert.equal(result.body.data[0].manufacturer, "L&T");
  assert.equal(result.body.meta.total_pages, 1);
  assert.ok(seen[1].cookie.includes(SESSION_COOKIE));
  for (const secret of [
    "test-password",
    "test-session",
    "test@example.com",
    "J100007",
  ])
    assert.ok(!logs().includes(secret));
});

test("logout revokes the Urja session and returns no upstream cookie", async (t) => {
  const { app, seen } = await fixture(t);
  const response = await request(app)
    .post("/api/v1/auth/logout")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.deepEqual(response.body.data, { logged_out: true });
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/api/auth/sign-out");
  assert.ok(seen[0].cookie.includes(`${SESSION_COOKIE}=test-session`));
  await request(app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "test-session")
    .expect(401);
  await request(app).post("/api/v1/auth/logout").expect(401);
});

test("logout rejects malformed success and missing cookie deletion", async (t) => {
  const malformed = await fixture(t, { logoutRaw: "not-json" });
  await request(malformed.app)
    .post("/api/v1/auth/logout")
    .set("X-Urja-Session", "test-session")
    .expect(502);

  const notCleared = await fixture(t, { logoutClears: false });
  await request(notCleared.app)
    .post("/api/v1/auth/logout")
    .set("X-Urja-Session", "test-session")
    .expect(502);
});

test("missing/malformed auth never contacts portal; invalid session maps to 401", async (t) => {
  const { app, seen } = await fixture(t);
  await request(app).get("/api/v1/meters").expect(401);
  await request(app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "a;b=c")
    .expect(401);
  assert.equal(seen.length, 0);
  const rejected = await request(app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "invalid")
    .expect(401);
  assert.equal(rejected.body.error.code, "PORTAL_SESSION_INVALID");
});

test("concurrent callers retain their own cookie and query values are encoded", async (t) => {
  const { app, seen } = await fixture(t);
  await Promise.all(
    ["test-session", "other-session"].map((token) =>
      request(app)
        .get("/api/v1/meters")
        .query({ q: "L&T", page: 1 })
        .set("X-Urja-Session", token)
        .expect(200),
    ),
  );
  assert.deepEqual(
    new Set(seen.map((row) => row.cookie)),
    new Set([
      `${SESSION_COOKIE}=test-session`,
      `${SESSION_COOKIE}=other-session`,
    ]),
  );
  assert.ok(
    seen.every(
      (row) => new URL(row.url, "http://test").searchParams.get("q") === "L&T",
    ),
  );
});

test("invalid queries rejected; empty results and unknown categories represented explicitly", async (t) => {
  const { app, seen } = await fixture(t, {
    payload: { data: [], total: 0, page: 1, pageSize: 20 },
  });
  for (const query of ["page=0", "page=1.2", "page=1&page=2", "extra=yes"])
    await request(app)
      .get(`/api/v1/meters?${query}`)
      .set("X-Urja-Session", "test-session")
      .expect(400);
  assert.equal(seen.length, 0);
  const result = await request(app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(result.body.meta.total_pages, 0);
  const other = await fixture(t, {
    payload: {
      ...payload,
      data: [{ ...payload.data[0], installStatus: "NewStatus" }],
    },
  });
  const unknown = await request(other.app)
    .get("/api/v1/meters")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(unknown.body.data[0].installation_status, "unknown");
  assert.equal(unknown.body.meta.warnings[0].source_value, "NewStatus");
});

test("portal errors, malformed payload and cookie rotation have explicit outcomes", async (t) => {
  for (const [options, expected, code] of [
    [{ status: 403 }, 403, "FORBIDDEN"],
    [{ status: 500 }, 503, "PORTAL_UNAVAILABLE"],
    [{ raw: "<html>broken</html>" }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ payload: { ...payload, page: 2 } }, 502, "PORTAL_INVALID_RESPONSE"],
    [{ rotation: true }, 401, "PORTAL_SESSION_CHANGED"],
    [{ timeoutMs: 50, delay: 200 }, 504, "PORTAL_TIMEOUT"],
  ]) {
    const { app } = await fixture(t, options);
    const result = await request(app)
      .get("/api/v1/meters")
      .set("X-Urja-Session", "test-session")
      .expect(expected);
    assert.equal(result.body.error.code, code);
  }
});

test("login validates JSON and credentials and throttles attempts", async (t) => {
  const { app } = await fixture(t);
  await request(app)
    .post("/api/v1/auth/login")
    .type("form")
    .send("email=a")
    .expect(415);
  await request(app)
    .post("/api/v1/auth/login")
    .set("Content-Type", "application/json")
    .send("{bad")
    .expect(400);
  await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "bad", password: "" })
    .expect(400);
  await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "test@example.com", password: "wrong" })
    .expect(401);
  await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "test@example.com", password: "x".repeat(9000) })
    .expect(413);
  const limited = await fixture(t, { loginLimit: 1 });
  await request(limited.app).post("/api/v1/auth/login").send({}).expect(400);
  await request(limited.app).post("/api/v1/auth/login").send({}).expect(429);
});

test("health and docs are public; invalid configuration fails closed", async (t) => {
  const { app, seen } = await fixture(t);
  await request(app).get("/health").expect(200);
  await request(app).get("/docs/").expect(200);
  const spec = await request(app).get("/openapi.json").expect(200);
  assert.equal(
    spec.body.components.securitySchemes.UrjaSession.name,
    "X-Urja-Session",
  );
  assert.ok(spec.body.paths["/api/v1/meters/all"]);
  await request(app).get("/missing").expect(404);
  assert.equal(seen.length, 0);
  assert.throws(() => readConfig({ PORTAL_ORIGIN: "http://example.com" }));
  assert.throws(() => readConfig({ PORT: "bad" }));
  assert.equal(readConfig({}).HOST, "127.0.0.1");
  assert.equal(readConfig({}).TRUST_PROXY, false);
  assert.equal(readConfig({ RENDER: "true", PORT: "10000" }).HOST, "0.0.0.0");
  assert.equal(readConfig({ RENDER: "true" }).TRUST_PROXY, true);
  assert.equal(readConfig({ RENDER: "true", HOST: "127.0.0.1" }).HOST, "127.0.0.1");
});

test("meters/all walks pages, combines rows, and rejects page query", async (t) => {
  const rows = [
    {
      meterId: "J100000",
      serialNo: "S1",
      make: "HPL",
      phaseType: "single",
      installStatus: "Installed",
      dtCode: "DT-001",
    },
    {
      meterId: "J100001",
      serialNo: "S2",
      make: "Genus",
      phaseType: "three",
      installStatus: "Faulty",
      dtCode: "DT-002",
    },
    {
      meterId: "J100002",
      serialNo: "S3",
      make: "Allied",
      phaseType: "single",
      installStatus: "Decommissioned",
      dtCode: "DT-003",
    },
  ];
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url);
    if (!req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`)) {
      res.writeHead(401).end("{}");
      return;
    }
    const url = new URL(req.url, "http://test");
    assert.equal(url.pathname, "/portal/meters/search");
    const page = Number(url.searchParams.get("page"));
    const pageSize = 2;
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: slice,
        total: rows.length,
        page,
        pageSize,
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const app = createApp({
    portal: new PortalClient({
      origin: `http://127.0.0.1:${upstream.address().port}`,
      timeoutMs: 1000,
    }),
    logger: createLogger("silent"),
    timeoutMs: 5000,
  });

  await request(app)
    .get("/api/v1/meters/all?page=1")
    .set("X-Urja-Session", "test-session")
    .expect(400);
  assert.equal(seen.length, 0);

  const result = await request(app)
    .get("/api/v1/meters/all?q=")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(result.body.data.length, 3);
  assert.deepEqual(
    result.body.data.map((row) => row.meter_id),
    ["J100000", "J100001", "J100002"],
  );
  assert.equal(result.body.meta.total, 3);
  assert.equal(result.body.meta.returned_count, 3);
  assert.equal(result.body.meta.page_size, 2);
  assert.equal(result.body.meta.pages_fetched, 2);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes("page=1"));
  assert.ok(seen[1].includes("page=2"));
});

test("meters/all empty search returns empty data after one portal page", async (t) => {
  const { app, seen } = await fixture(t, {
    payload: { data: [], total: 0, page: 1, pageSize: 20 },
  });
  const result = await request(app)
    .get("/api/v1/meters/all")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.deepEqual(result.body.data, []);
  assert.equal(result.body.meta.total, 0);
  assert.equal(result.body.meta.returned_count, 0);
  assert.equal(result.body.meta.pages_fetched, 1);
  assert.equal(seen.length, 1);
});
