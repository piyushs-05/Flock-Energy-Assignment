import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import {
  distanceMeters,
  filterExportedMeters,
  nearbyExportedMeters,
  parseMeterQuery,
  parseNearbyQuery,
  summarizeExportedMeters,
} from "../src/query.js";

const sample = {
  meta: { total: 3, returned_count: 3 },
  data: [
    {
      meter_id: "J1",
      serial_number: "S1",
      manufacturer: "Genus",
      phase_type: "three",
      installation_status: "faulty",
      installation_type: "ct_operated",
      transformer_code: "DT-008",
      coordinates: { latitude: 26.83, longitude: 75.8 },
      hierarchy: {},
    },
    {
      meter_id: "J2",
      serial_number: "S2",
      manufacturer: "HPL",
      phase_type: "single",
      installation_status: "installed",
      installation_type: "whole_current",
      transformer_code: "DT-001",
      coordinates: { latitude: 26.831, longitude: 75.801 },
      hierarchy: {},
    },
    {
      meter_id: "J3",
      serial_number: "S3",
      manufacturer: "Genus",
      phase_type: "three",
      installation_status: "faulty",
      installation_type: "ct_operated",
      transformer_code: "DT-008",
      coordinates: { latitude: null, longitude: null },
      hierarchy: {},
    },
  ],
};

test("parseMeterQuery requires a filter and validates enums", () => {
  assert.throws(() => parseMeterQuery({}), /at least one filter/);
  assert.throws(() => parseMeterQuery({ status: "broken" }), /status must be/);
  const parsed = parseMeterQuery({
    status: "faulty",
    transformer_code: "DT-008",
    phase_type: "three",
    page: "1",
    page_size: "10",
  });
  assert.deepEqual(parsed.filters, {
    status: "faulty",
    transformer_code: "DT-008",
    phase_type: "three",
  });
  assert.equal(parsed.page_size, 10);
});

test("filterExportedMeters ANDs filters and paginates locally", () => {
  const result = filterExportedMeters(sample, {
    filters: {
      status: "faulty",
      transformer_code: "DT-008",
      phase_type: "three",
    },
    page: 1,
    page_size: 10,
  });
  assert.equal(result.meta.matched_total, 2);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].meter_id, "J1");
  assert.equal(result.meta.query_mode, "export_filter");
  assert.equal(result.meta.snapshot_total, 3);
});

test("summarizeExportedMeters counts satisfy all three invariants", () => {
  const result = summarizeExportedMeters(sample);
  const { total_meters, by_installation_status, by_phase_type, by_manufacturer } =
    result.data;
  assert.equal(total_meters, 3);
  assert.equal(
    Object.values(by_installation_status).reduce((a, b) => a + b, 0),
    total_meters,
  );
  assert.equal(
    Object.values(by_phase_type).reduce((a, b) => a + b, 0),
    total_meters,
  );
  assert.equal(
    Object.values(by_manufacturer).reduce((a, b) => a + b, 0),
    total_meters,
  );
  assert.equal(by_installation_status.faulty, 2);
  assert.equal(by_installation_status.installed, 1);
  assert.equal(by_phase_type.three, 2);
  assert.equal(by_manufacturer.Genus, 2);
  assert.equal(by_manufacturer.HPL, 1);
  assert.equal(result.meta.query_mode, "export_summary");
  assert.equal(result.meta.snapshot_total, 3);
});

test("nearby sorts by distance and reports missing coordinates", () => {
  assert.ok(distanceMeters(26.83, 75.8, 26.831, 75.801) < 200);
  const result = nearbyExportedMeters(sample, {
    latitude: 26.83,
    longitude: 75.8,
    radius_m: 1000,
    limit: 50,
  });
  assert.equal(result.meta.excluded_missing_coordinates, 1);
  assert.equal(result.meta.matched_within_radius, 2);
  assert.equal(result.data[0].meter_id, "J1");
  assert.ok(result.data[0].distance_m <= result.data[1].distance_m);
  assert.equal(result.warnings[0].code, "SOURCE_DATA_WARNING");
});

test("parseNearbyQuery validates coordinates and bounds", () => {
  assert.throws(() => parseNearbyQuery({}), /latitude and longitude/);
  assert.throws(
    () => parseNearbyQuery({ latitude: "100", longitude: "75" }),
    /latitude must be between/,
  );
  const parsed = parseNearbyQuery({
    latitude: "26.83",
    longitude: "75.80",
    radius_m: "1000",
  });
  assert.equal(parsed.radius_m, 1000);
  assert.equal(parsed.limit, 50);
});

test("query, nearby, and summary routes use export snapshot and reject bad input", async () => {
  let exports = 0;
  const portal = {
    queryMeters: async (_token, query) => {
      exports += 1;
      return filterExportedMeters(sample, query);
    },
    nearbyMeters: async (_token, query) => {
      exports += 1;
      return nearbyExportedMeters(sample, query);
    },
    metersSummary: async () => {
      exports += 1;
      return summarizeExportedMeters(sample);
    },
  };
  const app = createApp({ portal, logger: createLogger("silent") });

  await request(app)
    .get("/api/v1/meters/query")
    .set("X-Urja-Session", "token")
    .expect(400);
  const filtered = await request(app)
    .get(
      "/api/v1/meters/query?status=faulty&transformer_code=DT-008&phase_type=three",
    )
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(filtered.body.meta.matched_total, 2);
  assert.equal(filtered.body.meta.query_mode, "export_filter");

  const nearby = await request(app)
    .get("/api/v1/meters/nearby?latitude=26.83&longitude=75.80&radius_m=1000")
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(nearby.body.meta.excluded_missing_coordinates, 1);
  assert.ok(nearby.body.data[0].distance_m >= 0);

  const summary = await request(app)
    .get("/api/v1/meters/summary")
    .set("X-Urja-Session", "token")
    .expect(200);
  assert.equal(summary.body.data.total_meters, 3);
  assert.equal(summary.body.meta.query_mode, "export_summary");
  await request(app)
    .get("/api/v1/meters/summary?extra=1")
    .set("X-Urja-Session", "token")
    .expect(400);
  assert.equal(exports, 3);
});
