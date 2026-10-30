import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { stringify } from "devalue";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/errors.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";
import { createLogger } from "../src/logger.js";
import { filterExportedMeters, matchExportedRows } from "../src/query.js";
import {
  summarizeTransformerMeters,
  transformerMeterList,
  transformerSummaryFromExport,
} from "../src/transformers.js";

const exportSample = {
  meta: { total: 4, returned_count: 4 },
  warnings: [
    {
      code: "SOURCE_DATA_WARNING",
      field: "data.0.coordinates.latitude",
      message: "Absent",
    },
    {
      code: "SOURCE_DATA_WARNING",
      field: "data.2.hierarchy.zone",
      message: "Missing",
    },
  ],
  data: [
    {
      meter_id: "J100002",
      serial_number: "S2",
      manufacturer: "HPL",
      phase_type: "single",
      installation_status: "installed",
      installation_type: "ct_operated",
      transformer_code: "DT-008",
      coordinates: { latitude: 26.83, longitude: 75.8 },
    },
    {
      meter_id: "J100001",
      serial_number: "S1",
      manufacturer: "Genus",
      phase_type: "three",
      installation_status: "faulty",
      installation_type: "ct_operated",
      transformer_code: "DT-008",
      coordinates: { latitude: 26.84, longitude: 75.81 },
    },
    {
      meter_id: "J100003",
      serial_number: "S3",
      manufacturer: "Genus",
      phase_type: "single",
      installation_status: "faulty",
      installation_type: "whole_current",
      transformer_code: "DT-001",
      coordinates: { latitude: null, longitude: null },
    },
    {
      meter_id: "J100000",
      serial_number: "S0",
      manufacturer: "Allied",
      phase_type: "three",
      installation_status: "decommissioned",
      installation_type: "ct_operated",
      transformer_code: "DT-008",
      coordinates: { latitude: 26.82, longitude: 75.79 },
    },
  ],
};

test("filterExportedMeters sorts by meter_id and remaps warnings to meter ids", () => {
  const result = filterExportedMeters(exportSample, {
    filters: { transformer_code: "DT-008" },
    page: 1,
    page_size: 10,
  });
  assert.deepEqual(
    result.data.map((row) => row.meter_id),
    ["J100000", "J100001", "J100002"],
  );
  assert.equal(result.meta.matched_total, 3);
  assert.ok(result.warnings.some((w) => w.field.startsWith("meters.J100002.")));
  assert.ok(!result.warnings.some((w) => /^data\.\d+\./.test(w.field)));
});

test("transformer meter list reports assigned_total vs matched_total", () => {
  const result = transformerMeterList(exportSample, "DT-008", {
    filters: { status: "faulty" },
    page: 1,
    page_size: 20,
  });
  assert.equal(result.meta.assigned_total, 3);
  assert.equal(result.meta.matched_total, 1);
  assert.equal(result.data[0].meter_id, "J100001");
});

test("transformer summary counts satisfy invariants", () => {
  const result = transformerSummaryFromExport(exportSample, "DT-008");
  const { total_meters, by_installation_status, by_phase_type } = result.data;
  assert.equal(total_meters, 3);
  assert.equal(
    Object.values(by_installation_status).reduce((a, b) => a + b, 0),
    total_meters,
  );
  assert.equal(
    Object.values(by_phase_type).reduce((a, b) => a + b, 0),
    total_meters,
  );
  assert.equal(by_installation_status.faulty, 1);
  assert.equal(by_installation_status.installed, 1);
  assert.equal(by_installation_status.decommissioned, 1);
});

test("summarizeTransformerMeters zeros known buckets", () => {
  const empty = summarizeTransformerMeters([]);
  assert.equal(empty.total_meters, 0);
  assert.equal(empty.by_installation_status.installed, 0);
  assert.equal(empty.by_phase_type.single, 0);
});

test("matchExportedRows is stable for shared filter reuse", () => {
  const matched = matchExportedRows(exportSample, { status: "faulty" });
  assert.deepEqual(
    matched.map((entry) => entry.row.meter_id),
    ["J100001", "J100003"],
  );
});

const id = "J100007";
const fields = {
  MeterId: id,
  SerialNo: "SE11409",
  Make: "Genus",
  PhaseType: "single",
  InstallationStatus: "Decommissioned",
  InstallationType: "CT Operated",
};
const hierarchy = {
  Zone: "Jaipur Zone 2 (Z-02)",
  Circle: "Circle 2 (C-02)",
  Division: "Division 8 (D-08)",
  Subdivision: "Subdivision 8 (SD-08)",
  "Sub Station": "Substation 8 (SS-08)",
  Feeder: "Feeder 8 (F-008)",
  DT: "Tonk Road DT 8 (DT-008)",
};
const detailBody = {
  type: "data",
  nodes: [
    { type: "skip" },
    { type: "skip" },
    {
      type: "data",
      data: JSON.parse(
        stringify({
          meterId: id,
          detail: { classData: JSON.stringify({ installed_meter: fields }) },
          hierarchy,
        }),
      ),
    },
  ],
};

test("overview uses one detail fetch and returns all latest duplicate readings", async (t) => {
  let detailHits = 0;
  const upstream = createServer(async (req, res) => {
    if (!req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`)) {
      res.writeHead(401).end("{}");
      return;
    }
    const url = new URL(req.url, "http://test");
    if (url.pathname.endsWith("/__data.json")) {
      detailHits += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(detailBody));
      return;
    }
    if (url.pathname.endsWith("/geo")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: { latitude: "26.83", longitude: "75.80" },
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/energy")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              timestamp: "24/06/2026 00:00",
              kwh: "1",
              kvah: "2",
              voltR: "230",
            },
            {
              timestamp: "24/06/2026 00:30",
              kwh: "3",
              kvah: "4",
              voltR: "231",
            },
            {
              timestamp: "24/06/2026 00:30",
              kwh: "3.1",
              kvah: "4.1",
              voltR: "232",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end("{}");
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
      timeoutMs: 2000,
    }),
    logger: createLogger("silent"),
    timeoutMs: 5000,
  });
  const result = await request(app)
    .get("/api/v1/meters/J100007/overview")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(detailHits, 1);
  assert.equal(result.body.data.meter_id, "J100007");
  assert.equal(
    result.body.data.nameplate.installation_status,
    "decommissioned",
  );
  assert.equal(result.body.data.readings_summary.reading_count, 3);
  assert.equal(result.body.data.readings_summary.latest_readings.length, 2);
  assert.ok(
    result.body.data.readings_summary.latest_readings.every(
      (row) => row.timestamp === "2026-06-24T00:30:00",
    ),
  );
  assert.equal(result.body.meta.composite, true);
});

test("overview empty energy returns zero readings without inventing a range", async (t) => {
  const upstream = createServer(async (req, res) => {
    if (!req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`)) {
      res.writeHead(401).end("{}");
      return;
    }
    const url = new URL(req.url, "http://test");
    if (url.pathname.endsWith("/__data.json")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(detailBody));
      return;
    }
    if (url.pathname.endsWith("/geo")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: { latitude: null, longitude: null },
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/energy")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404).end("{}");
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
      timeoutMs: 2000,
    }),
    logger: createLogger("silent"),
    timeoutMs: 5000,
  });
  const result = await request(app)
    .get("/api/v1/meters/J100007/overview")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(result.body.data.readings_summary.reading_count, 0);
  assert.equal(result.body.data.readings_summary.available_from, null);
  assert.equal(result.body.data.readings_summary.available_to, null);
  assert.deepEqual(result.body.data.readings_summary.latest_readings, []);
  assert.equal(result.body.data.location.coordinates.latitude, null);
});

test("transformer HTTP routes: list, summary, 404, and rejected query conflict", async () => {
  const portal = {
    transformerMeters: async (_token, code, query) => {
      if (code === "DT-MISSING")
        throw new ApiError(
          404,
          "TRANSFORMER_NOT_FOUND",
          "Transformer not found.",
        );
      return transformerMeterList(exportSample, code, query);
    },
    transformerSummary: async (_token, code) => {
      if (code === "DT-EMPTY")
        return {
          data: {
            transformer_code: code,
            total_meters: 0,
            by_installation_status: {
              installed: 0,
              faulty: 0,
              decommissioned: 0,
              unknown: 0,
            },
            by_phase_type: { single: 0, three: 0, unknown: 0 },
          },
          meta: {
            query_mode: "transformer_summary",
            transformer_code: code,
            snapshot_total: 4,
            assigned_total: 0,
          },
          warnings: [],
        };
      return transformerSummaryFromExport(exportSample, code);
    },
  };
  const app = createApp({ portal, logger: createLogger("silent") });
  await request(app)
    .get("/api/v1/transformers/DT-MISSING/meters")
    .set("X-Urja-Session", "token")
    .expect(404);
  const list = await request(app)
    .get("/api/v1/transformers/DT-008/meters?status=faulty")
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(list.body.meta.assigned_total, 3);
  assert.equal(list.body.meta.matched_total, 1);
  await request(app)
    .get("/api/v1/transformers/DT-008/meters?transformer_code=DT-001")
    .set("X-Urja-Session", "token")
    .expect(400);
  const summary = await request(app)
    .get("/api/v1/transformers/DT-008/summary")
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(summary.body.data.total_meters, 3);
  const empty = await request(app)
    .get("/api/v1/transformers/DT-EMPTY/summary")
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(empty.body.data.total_meters, 0);
});

test("catalogueHasTransformer walks DT pages; unknown code 404s after empty assignment", async (t) => {
  const upstream = createServer((req, res) => {
    if (!req.headers.cookie?.includes(`${SESSION_COOKIE}=test-session`)) {
      res.writeHead(401).end("{}");
      return;
    }
    const url = new URL(req.url, "http://test");
    if (url.pathname === "/portal/keys") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { signingSecret: "secret" } }));
      return;
    }
    if (url.pathname === "/portal/export") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          total: 1,
          data: [
            {
              meterId: "J1",
              serialNo: "S1",
              make: "Genus",
              phaseType: "single",
              installStatus: "Installed",
              installType: "CT Operated",
              dtCode: "DT-001",
              hierarchy: {
                zone: { name: "Z", code: "Z-1" },
                circle: { name: "C", code: "C-1" },
                division: { name: "D", code: "D-1" },
                subdivision: { name: "SD", code: "SD-1" },
                substation: { name: "SS", code: "SS-1" },
                feeder: { name: "F", code: "F-1" },
                dt: { name: "DT", code: "DT-001" },
              },
              geo: { lat: 26.8, lng: 75.8 },
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/portal/dts") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              code: "DT-001",
              name: "Known",
              feederCode: "F-1",
              capacityKva: 100,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      );
      return;
    }
    res.writeHead(404).end("{}");
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
      timeoutMs: 2000,
      now: () => 1_700_000_000_000,
    }),
    logger: createLogger("silent"),
    timeoutMs: 10000,
  });
  await request(app)
    .get("/api/v1/transformers/DT-999/meters")
    .set("X-Urja-Session", "test-session")
    .expect(404);
  const emptyKnown = await request(app)
    .get("/api/v1/transformers/DT-001/meters?status=faulty")
    .set("X-Urja-Session", "test-session")
    .expect(200);
  assert.equal(emptyKnown.body.meta.assigned_total, 1);
  assert.equal(emptyKnown.body.meta.matched_total, 0);
  assert.deepEqual(emptyKnown.body.data, []);
});
