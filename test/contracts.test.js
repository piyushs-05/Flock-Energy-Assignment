import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { ApiError } from "../src/errors.js";

const spec = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url)),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map();
function validate(path, method, status, body) {
  const key = `${path}:${method}:${status}`;
  if (!validators.has(key)) {
    const schema =
      spec.paths[path][method].responses[status]?.content?.["application/json"]
        ?.schema;
    assert.ok(schema, `Missing contract for ${key}`);
    validators.set(
      key,
      ajv.compile({ ...schema, components: spec.components }),
    );
  }
  const validator = validators.get(key);
  assert.ok(validator(body), `${key}: ${JSON.stringify(validator.errors)}`);
}

test("HTTP success and error responses conform to all public operation schemas", async () => {
  const row = {
    meter_id: "J1",
    serial_number: "SER",
    manufacturer: "Genus",
    phase_type: "single",
    installation_status: "installed",
  };
  const pagination = { page: 1, page_size: 20, total: 1, total_pages: 1 };
  const portal = {
    login: async () => ({ session_token: "fixture-session", expires_at: null }),
    logout: async () => ({ data: { logged_out: true } }),
    search: async () => ({
      data: [{ ...row, transformer_code: "DT-1" }],
      pagination,
      warnings: [],
    }),
    searchAll: async () => ({
      data: [{ ...row, transformer_code: "DT-1" }],
      meta: {
        total: 1,
        returned_count: 1,
        page_size: 20,
        pages_fetched: 1,
      },
      warnings: [],
    }),
    detail: async () => ({
      data: { ...row, installation_type: "ct_operated" },
    }),
    location: async () => ({
      data: {
        meter_id: "J1",
        coordinates: { latitude: null, longitude: 75 },
        hierarchy: Object.fromEntries(
          [
            "zone",
            "circle",
            "division",
            "subdivision",
            "substation",
            "feeder",
            "transformer",
          ].map((key) => [key, null]),
        ),
      },
      warnings: [
        {
          code: "SOURCE_DATA_WARNING",
          field: "coordinates.latitude",
          message: "Absent",
        },
      ],
    }),
    readings: async () => ({
      data: [
        {
          timestamp: "2026-06-24T00:00:00",
          active_energy_kwh: 1,
          apparent_energy_kvah: 2,
          voltage_r_v: 230,
        },
      ],
      meta: {
        meter_id: "J1",
        timestamp_timezone: null,
        available_from: "2026-06-24T00:00:00",
        available_to: "2026-06-24T00:00:00",
        returned_count: 1,
      },
    }),
    exportMeters: async () => ({
      data: [
        {
          ...row,
          installation_type: "ct_operated",
          transformer_code: "DT-1",
          coordinates: { latitude: null, longitude: null },
          hierarchy: Object.fromEntries(
            [
              "zone",
              "circle",
              "division",
              "subdivision",
              "substation",
              "feeder",
              "transformer",
            ].map((key) => [key, null]),
          ),
        },
      ],
      meta: { total: 1, returned_count: 1 },
    }),
    queryMeters: async () => ({
      data: [
        {
          ...row,
          installation_type: "ct_operated",
          transformer_code: "DT-1",
          coordinates: { latitude: 26.83, longitude: 75.8 },
        },
      ],
      meta: {
        query_mode: "export_filter",
        snapshot_total: 1,
        matched_total: 1,
        page: 1,
        page_size: 20,
        total_pages: 1,
        filters: { status: "installed" },
      },
      warnings: [],
    }),
    nearbyMeters: async () => ({
      data: [
        {
          ...row,
          installation_type: "ct_operated",
          transformer_code: "DT-1",
          coordinates: { latitude: 26.83, longitude: 75.8 },
          distance_m: 12.5,
        },
      ],
      meta: {
        query_mode: "export_nearby",
        snapshot_total: 1,
        latitude: 26.83,
        longitude: 75.8,
        radius_m: 1000,
        limit: 50,
        matched_within_radius: 1,
        returned_count: 1,
        excluded_missing_coordinates: 0,
      },
      warnings: [],
    }),
    metersSummary: async () => ({
      data: {
        total_meters: 1,
        by_installation_status: {
          installed: 1,
          faulty: 0,
          decommissioned: 0,
          unknown: 0,
        },
        by_phase_type: { single: 1, three: 0, unknown: 0 },
        by_manufacturer: { Genus: 1 },
      },
      meta: {
        query_mode: "export_summary",
        snapshot_total: 1,
      },
      warnings: [],
    }),
    overview: async () => ({
      data: {
        meter_id: "J1",
        nameplate: {
          serial_number: "SER",
          manufacturer: "Genus",
          phase_type: "single",
          installation_status: "installed",
          installation_type: "ct_operated",
        },
        location: {
          coordinates: { latitude: 26.83, longitude: 75.8 },
          hierarchy: Object.fromEntries(
            [
              "zone",
              "circle",
              "division",
              "subdivision",
              "substation",
              "feeder",
              "transformer",
            ].map((key) => [key, null]),
          ),
        },
        readings_summary: {
          available_from: "2026-06-24T00:00:00",
          available_to: "2026-06-24T00:00:00",
          reading_count: 1,
          timestamp_timezone: null,
          latest_readings: [
            {
              timestamp: "2026-06-24T00:00:00",
              active_energy_kwh: 1,
              apparent_energy_kvah: 2,
              voltage_r_v: 230,
            },
          ],
        },
      },
      meta: {
        composite: true,
        note: "Combined from separate portal reads; not an atomic snapshot.",
      },
      warnings: [],
    }),
    transformerMeters: async () => ({
      data: [
        {
          ...row,
          installation_type: "ct_operated",
          transformer_code: "DT-1",
          coordinates: { latitude: 26.83, longitude: 75.8 },
        },
      ],
      meta: {
        query_mode: "transformer_meters",
        transformer_code: "DT-1",
        snapshot_total: 1,
        assigned_total: 1,
        matched_total: 1,
        page: 1,
        page_size: 20,
        total_pages: 1,
        filters: { transformer_code: "DT-1" },
      },
      warnings: [],
    }),
    transformerSummary: async () => ({
      data: {
        transformer_code: "DT-1",
        total_meters: 1,
        by_installation_status: {
          installed: 1,
          faulty: 0,
          decommissioned: 0,
          unknown: 0,
        },
        by_phase_type: { single: 1, three: 0, unknown: 0 },
      },
      meta: {
        query_mode: "transformer_summary",
        transformer_code: "DT-1",
        snapshot_total: 1,
        assigned_total: 1,
      },
      warnings: [],
    }),
    transformers: async () => ({
      data: [
        {
          code: "DT-1",
          name: "Source name",
          feeder_code: "F-1",
          capacity_kva: 100,
        },
      ],
      meta: pagination,
    }),
  };
  const app = createApp({ portal, logger: createLogger("silent") });
  const cases = [
    ["/api/v1/meters/export", "/api/v1/meters/export"],
    ["/health", "/health"],
    ["/api/v1/meters", "/api/v1/meters"],
    ["/api/v1/meters/all", "/api/v1/meters/all"],
    ["/api/v1/meters/query?status=installed", "/api/v1/meters/query"],
    [
      "/api/v1/meters/nearby?latitude=26.83&longitude=75.8&radius_m=1000",
      "/api/v1/meters/nearby",
    ],
    ["/api/v1/meters/summary", "/api/v1/meters/summary"],
    ["/api/v1/meters/J1", "/api/v1/meters/{meter_id}"],
    ["/api/v1/meters/J1/overview", "/api/v1/meters/{meter_id}/overview"],
    ["/api/v1/meters/J1/location", "/api/v1/meters/{meter_id}/location"],
    ["/api/v1/meters/J1/readings", "/api/v1/meters/{meter_id}/readings"],
    ["/api/v1/transformers", "/api/v1/transformers"],
    [
      "/api/v1/transformers/DT-1/meters",
      "/api/v1/transformers/{transformer_code}/meters",
    ],
    [
      "/api/v1/transformers/DT-1/summary",
      "/api/v1/transformers/{transformer_code}/summary",
    ],
  ];
  for (const [url, path] of cases) {
    const response = await request(app)
      .get(url)
      .set("X-Urja-Session", "fixture-session")
      .expect(200);
    validate(path, "get", 200, response.body);
    if (url !== "/health") {
      const rejected = await request(app).get(url).expect(401);
      validate(path, "get", 401, rejected.body);
    }
  }
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "test@example.com", password: "test" })
    .expect(200);
  validate("/api/v1/auth/login", "post", 200, login.body);
  const logout = await request(app)
    .post("/api/v1/auth/logout")
    .set("X-Urja-Session", "fixture-session")
    .expect(200);
  validate("/api/v1/auth/logout", "post", 200, logout.body);
  const invalid = await request(app)
    .get("/api/v1/meters?page=0")
    .set("X-Urja-Session", "fixture-session")
    .expect(400);
  validate("/api/v1/meters", "get", 400, invalid.body);
  for (const [status, code] of [
    [401, "PORTAL_SESSION_CHANGED"],
    [403, "FORBIDDEN"],
    [404, "METER_NOT_FOUND"],
    [502, "PORTAL_RESPONSE_TOO_LARGE"],
    [503, "PORTAL_RATE_LIMITED"],
    [504, "PORTAL_TIMEOUT"],
  ]) {
    portal.detail = async () => {
      throw new ApiError(status, code, "Fixture failure");
    };
    const response = await request(app)
      .get("/api/v1/meters/J1")
      .set("X-Urja-Session", "fixture-session")
      .expect(status);
    validate("/api/v1/meters/{meter_id}", "get", status, response.body);
  }
});
