import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { stringify } from "devalue";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";
import {
  decodeDetail,
  normalizeLocation,
  normalizeReadings,
  normalizeTransformers,
  validLocalTimestamp,
} from "../src/resources.js";

const id = "J100007";
const fields = {
  MeterId: id,
  SerialNo: "SE11409",
  Make: "L&T",
  PhaseType: "single",
  InstallationStatus: "Decommissioned",
  InstallationType: "CT Operated",
};
const hierarchy = {
  "Meter ID": id,
  "Installation Status": "Decommissioned",
  "Installation Type": "CT Operated",
  Zone: "Jaipur Zone 2 (Z-02)",
  Circle: "Circle 2 (C-02)",
  Division: "Division 8 (D-08)",
  Subdivision: "Subdivision 8 (SD-08)",
  "Sub Station": "Substation 8 (SS-08)",
  Feeder: "Feeder 8 (F-008)",
  DT: "Old Malviya Nagar Xfmr (DT-007)",
};
const labels = [
  "Meter ID",
  "Serial No",
  "Make",
  "Phase Type",
  "Installation Status",
  "Installation Type",
];
const record = (legacy = false) => ({
  meterId: id,
  detail: legacy
    ? {
        data: Object.values(fields).map((parameterValue, i) => ({
          parameterName: labels[i],
          parameterValue,
        })),
      }
    : { classData: JSON.stringify({ installed_meter: fields }) },
  hierarchy: { ...hierarchy },
});
const wrap = (data) => ({
  type: "data",
  nodes: [
    { type: "skip" },
    { type: "data", data: JSON.parse(stringify({ other: true })) },
    { type: "skip" },
    { type: "data", data: JSON.parse(stringify(data)) },
  ],
});
const absent = {
  type: "data",
  nodes: [
    { type: "skip" },
    { type: "error", status: 404, error: { message: "Meter not found" } },
  ],
};
const reading = (timestamp, kwh = "10.25") => ({
  timestamp,
  kwh,
  kvah: "11.5",
  voltR: "230",
});
const is502 = (error) =>
  error.status === 502 && error.code === "PORTAL_INVALID_RESPONSE";

test("legacy and v2 normalize identically independent of node position or meter status", () => {
  const legacy = decodeDetail(wrap(record(true)), id);
  const v2 = decodeDetail(wrap(record()), id);
  assert.deepEqual(legacy, v2);
  assert.equal(v2.data.installation_status, "decommissioned");
  assert.equal(v2.data.manufacturer, "L&T");
  assert.equal(v2.data.installation_type, "ct_operated");
  for (const status of ["Faulty", "Installed"]) {
    const r = record();
    r.detail.classData = JSON.stringify({
      installed_meter: { ...fields, InstallationStatus: status },
    });
    r.hierarchy["Installation Status"] = status;
    assert.equal(
      decodeDetail(wrap(r), id).data.installation_status,
      status.toLowerCase(),
    );
  }
});

test("detail rejects mismatched identities, conflicting labels, ambiguous nodes, and broken formats", () => {
  assert.throws(
    () => decodeDetail(absent, id),
    (error) => error.status === 404,
  );
  assert.throws(() => decodeDetail(wrap(record()), "OTHER"), is502);
  const conflicting = record(true);
  conflicting.detail.data.push({
    parameterName: "Make",
    parameterValue: "Different",
  });
  assert.throws(() => decodeDetail(wrap(conflicting), id), is502);
  const broken = record();
  broken.detail.classData = "{bad";
  assert.throws(() => decodeDetail(wrap(broken), id), is502);
  const ambiguous = wrap(record());
  ambiguous.nodes.push(ambiguous.nodes.at(-1));
  assert.throws(() => decodeDetail(ambiguous, id), is502);
  const badHierarchy = record();
  badHierarchy.hierarchy["Meter ID"] = "OTHER";
  assert.throws(() => decodeDetail(wrap(badHierarchy), id), is502);
  const corrupt = wrap(record());
  corrupt.nodes.at(-1).data = [{ meterId: 10000 }];
  assert.throws(() => decodeDetail(corrupt, id), is502);
});

test("location preserves source names, validates coordinates, and warns about missing hierarchy", () => {
  const detail = decodeDetail(wrap(record()), id);
  const result = normalizeLocation(detail, {
    data: { latitude: "26.5", longitude: "75.2" },
  });
  assert.deepEqual(result.data.coordinates, {
    latitude: 26.5,
    longitude: 75.2,
  });
  assert.deepEqual(result.data.hierarchy.transformer, {
    name: "Old Malviya Nagar Xfmr",
    code: "DT-007",
  });
  const missing = normalizeLocation(
    { ...detail, hierarchy: { Zone: "Unformatted name" } },
    { data: { latitude: "", longitude: null } },
  );
  assert.equal(missing.data.coordinates.latitude, null);
  assert.equal(missing.data.hierarchy.zone.code, null);
  assert.equal(missing.data.hierarchy.circle, null);
  assert.ok(missing.warnings.length >= 3);
  for (const latitude of ["NaN", " ", "91", "0x10"])
    assert.throws(
      () => normalizeLocation(detail, { data: { latitude, longitude: "75" } }),
      is502,
    );
});

test("readings validate dates and numbers, sort, filter inclusively, and preserve duplicates", () => {
  const source = {
    data: [
      reading("30/06/2026 23:30"),
      reading("24/06/2026 00:00"),
      reading("24/06/2026 00:00"),
    ],
  };
  const result = normalizeReadings(id, source, {
    from: "2026-06-24T00:00:00",
    to: "2026-06-24T00:00:00",
  });
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].active_energy_kwh, 10.25);
  assert.equal(result.data[0].timestamp, "2026-06-24T00:00:00");
  assert.equal(result.meta.available_to, "2026-06-30T23:30:00");
  assert.equal(result.meta.timestamp_timezone, null);
  assert.equal(result.warnings.length, 1);
  assert.equal(
    normalizeReadings(id, { data: [] }, {}).meta.available_from,
    null,
  );
  for (const timestamp of [
    "31/02/2026 00:00",
    "29/02/2026 00:00",
    "24/06/2026 24:00",
  ])
    assert.throws(
      () => normalizeReadings(id, { data: [reading(timestamp)] }, {}),
      is502,
    );
  assert.equal(validLocalTimestamp("2024-02-29T23:59:59"), true);
  assert.equal(validLocalTimestamp("2100-02-29T00:00:00"), false);
  assert.equal(validLocalTimestamp("2026-06-24T00:00:00Z"), false);
  assert.throws(
    () =>
      normalizeReadings(id, { data: [reading("24/06/2026 00:00", "")] }, {}),
    is502,
  );
  // Invalid data outside a requested range must not be hidden by filtering.
  assert.throws(
    () =>
      normalizeReadings(
        id,
        { data: [reading("24/06/2026 00:00", "Infinity")] },
        { from: "2026-07-01T00:00:00" },
      ),
    is502,
  );
});

test("transformers retain repeated feeders and enforce pagination and numeric capacity", () => {
  const payload = {
    data: [
      { code: "DT-001", name: "One", feederCode: "F-001", capacityKva: 100 },
      { code: "DT-029", name: "Two", feederCode: "F-001", capacityKva: 250 },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  };
  const result = normalizeTransformers(payload, 1);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[1].capacity_kva, 250);
  assert.throws(() => normalizeTransformers(payload, 2), is502);
  assert.throws(
    () =>
      normalizeTransformers(
        { ...payload, data: [{ ...payload.data[0], capacityKva: "100" }] },
        1,
      ),
    is502,
  );
});

async function fixture(t, options = {}) {
  const calls = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, "http://test");
    calls.push({ path: url.pathname, cookie: req.headers.cookie });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.includes("__data.json")) {
      if (options.rotate)
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=rotated; Secure; Path=/`,
        );
      return res.end(
        JSON.stringify(
          url.pathname.includes("J999999")
            ? absent
            : wrap(record(options.legacy)),
        ),
      );
    }
    if (options.status) {
      res.writeHead(options.status).end("{}");
      return;
    }
    if (url.pathname.endsWith("/geo"))
      return res.end(
        JSON.stringify({ data: { latitude: "26.5", longitude: "75.2" } }),
      );
    if (url.pathname.endsWith("/energy"))
      return res.end(
        JSON.stringify({
          data: [reading("24/06/2026 00:00"), reading("25/06/2026 00:00")],
        }),
      );
    res.end(
      JSON.stringify({
        data: [
          {
            code: "DT-001",
            name: "One",
            feederCode: "F-001",
            capacityKva: 100,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const portal = new PortalClient({
    origin: `http://127.0.0.1:${upstream.address().port}`,
  });
  return { app: createApp({ portal, logger: createLogger("silent") }), calls };
}

test("resource routes return documented envelopes and use the same isolated session within composites", async (t) => {
  const { app, calls } = await fixture(t, { legacy: true });
  for (const path of [
    `/api/v1/meters/${id}`,
    `/api/v1/meters/${id}/location`,
    `/api/v1/meters/${id}/readings?from=2026-06-24T00:00:00&to=2026-06-24T00:00:00`,
    "/api/v1/transformers?page=1",
  ]) {
    const result = await request(app)
      .get(path)
      .set("X-Urja-Session", "caller-session")
      .expect(200);
    assert.equal(result.body.meta.source, "urja_portal");
    assert.equal(result.headers["cache-control"], "no-store");
    if (path.includes("/readings"))
      assert.equal(result.body.meta.returned_count, 1);
  }
  assert.equal(calls.length, 6);
  assert.ok(
    calls.every((call) => call.cookie === `${SESSION_COOKIE}=caller-session`),
  );
});

test("absent meters stop composites before geo/energy; downstream failures do not return partial data", async (t) => {
  const { app, calls } = await fixture(t);
  for (const suffix of ["", "/location", "/readings"])
    await request(app)
      .get(`/api/v1/meters/J999999${suffix}`)
      .set("X-Urja-Session", "caller-session")
      .expect(404);
  assert.ok(calls.every((call) => call.path.includes("__data.json")));
  const broken = await fixture(t, { status: 500 });
  await request(broken.app)
    .get(`/api/v1/meters/${id}/location`)
    .set("X-Urja-Session", "caller-session")
    .expect(503);
  const rotated = await fixture(t, { rotate: true });
  const response = await request(rotated.app)
    .get(`/api/v1/meters/${id}/location`)
    .set("X-Urja-Session", "caller-session")
    .expect(401);
  assert.equal(response.body.error.code, "PORTAL_SESSION_CHANGED");
  assert.equal(rotated.calls.length, 1);
});

test("all new routes require credentials and reject invalid inputs before contacting Urja", async (t) => {
  const { app, calls } = await fixture(t);
  for (const path of [
    `/api/v1/meters/${id}`,
    `/api/v1/meters/${id}/location`,
    `/api/v1/meters/${id}/readings`,
    "/api/v1/transformers",
  ])
    await request(app).get(path).expect(401);
  for (const path of [
    "/api/v1/meters/bad.id",
    `/api/v1/meters/${id}?unknown=1`,
    `/api/v1/meters/${id}/readings?from=2026-02-30T00:00:00`,
    `/api/v1/meters/${id}/readings?from=2026-06-25T00:00:00&to=2026-06-24T00:00:00`,
    `/api/v1/meters/${id}/readings?from=a&from=b`,
    "/api/v1/transformers?page=0",
    "/api/v1/transformers?page=1&page=2",
  ])
    await request(app)
      .get(path)
      .set("X-Urja-Session", "caller-session")
      .expect(400);
  const method = await request(app).post(`/api/v1/meters/${id}`).expect(405);
  assert.equal(method.headers.allow, "GET, HEAD");
  assert.equal(calls.length, 0);
});

test("malformed percent encoding returns a client error without contacting Urja", async (t) => {
  const { app, calls } = await fixture(t);
  const result = await request(app)
    .get("/api/v1/meters/%E0%A4%A")
    .set("X-Urja-Session", "caller-session")
    .expect(400);
  assert.equal(result.body.error.code, "INVALID_REQUEST");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls.length, 0);
});
