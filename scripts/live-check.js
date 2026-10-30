import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Explicit opt-in live checks. Credentials exist only in process memory.
const origin = process.env.SMOKE_ORIGIN || "http://127.0.0.1:3000";
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
if (!email || !password)
  throw new Error("Set SMOKE_EMAIL and SMOKE_PASSWORD for the test account.");
const results = [];
let token;
async function check(
  name,
  path,
  status,
  { auth = true, verify, ...options } = {},
) {
  const start = performance.now();
  let actualStatus;
  try {
    const response = await fetch(new URL(path, origin), {
      ...options,
      headers: {
        ...(auth && token ? { "X-Urja-Session": token } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    actualStatus = response.status;
    assert.equal(
      response.status,
      status,
      `Expected HTTP ${status}; received ${response.status}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json")
      ? await response.json()
      : await response.text();
    if (status >= 400) {
      assert.equal(typeof body.error.code, "string");
      assert.equal(body.meta.request_id, response.headers.get("x-request-id"));
      assert.ok(!JSON.stringify(body).includes(password));
    }
    if (verify) await verify(body, response);
    results.push({
      name,
      status: "PASS",
      http: response.status,
      ms: Math.round(performance.now() - start),
    });
  } catch (error) {
    // Assertion messages contain no response bodies, credentials or headers.
    results.push({
      name,
      status: "FAIL",
      http: actualStatus ?? "unavailable",
      reason:
        error instanceof assert.AssertionError
          ? error.message
          : "Request or validation failed",
    });
  }
  console.log(`${results.at(-1).status}: ${name}`);
}

await check("Health", "/health", 200, {
  auth: false,
  verify: (b) => assert.equal(b.status, "ok"),
});
await check("Swagger UI", "/docs/", 200, {
  auth: false,
  verify: (b) => assert.ok(b.includes("swagger-ui")),
});
await check("OpenAPI lists all resource routes", "/openapi.json", 200, {
  auth: false,
  verify: (b) => {
    for (const path of [
      "/api/v1/auth/login",
      "/api/v1/auth/logout",
      "/api/v1/meters",
      "/api/v1/meters/all",
      "/api/v1/meters/export",
      "/api/v1/meters/query",
      "/api/v1/meters/nearby",
      "/api/v1/meters/summary",
      "/api/v1/meters/{meter_id}",
      "/api/v1/meters/{meter_id}/overview",
      "/api/v1/meters/{meter_id}/location",
      "/api/v1/meters/{meter_id}/readings",
      "/api/v1/transformers",
      "/api/v1/transformers/{transformer_code}/meters",
      "/api/v1/transformers/{transformer_code}/summary",
    ])
      assert.ok(b.paths[path]);
  },
});
await check(
  "Login returns usable session and expiry",
  "/api/v1/auth/login",
  200,
  {
    auth: false,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    verify: (b) => {
      assert.equal(typeof b.data.session_token, "string");
      assert.ok(b.data.session_token.length > 10);
      assert.ok(
        b.data.expires_at === null ||
          Date.parse(b.data.expires_at) > Date.now(),
      );
      token = b.data.session_token;
    },
  },
);
if (token) {
  await check(
    "Bulk export completeness and normalized alias",
    "/api/v1/meters/export",
    200,
    {
      verify: (b) => {
        assert.equal(b.meta.total, b.data.length);
        assert.equal(b.meta.returned_count, b.data.length);
        assert.ok(b.data.length > 0);
        assert.equal(
          new Set(b.data.map((r) => r.meter_id)).size,
          b.data.length,
        );
        assert.equal(
          b.data.find((r) => r.meter_id === "J100007").serial_number,
          "SE11409",
        );
        assert.equal(
          b.data.find((r) => r.meter_id === "J100400").hierarchy.transformer
            .name,
          "Old Malviya Nagar Xfmr",
        );
        assert.ok(!JSON.stringify(b).includes("signingSecret"));
      },
    },
  );
  await check(
    "Query filters by status and transformer",
    "/api/v1/meters/query?status=faulty&transformer_code=DT-008&page_size=5",
    200,
    {
      verify: (b) => {
        assert.equal(b.meta.query_mode, "export_filter");
        assert.ok(b.meta.matched_total >= 0);
        assert.ok(
          b.data.every(
            (r) =>
              r.installation_status === "faulty" &&
              r.transformer_code === "DT-008",
          ),
        );
      },
    },
  );
  await check(
    "Nearby returns distance and missing-coordinate count",
    "/api/v1/meters/nearby?latitude=26.83&longitude=75.80&radius_m=2000&limit=10",
    200,
    {
      verify: (b) => {
        assert.equal(b.meta.query_mode, "export_nearby");
        assert.ok(typeof b.meta.excluded_missing_coordinates === "number");
        assert.ok(b.data.length <= 10);
        assert.ok(b.data.every((r) => typeof r.distance_m === "number"));
        for (let i = 1; i < b.data.length; i++)
          assert.ok(b.data[i - 1].distance_m <= b.data[i].distance_m);
      },
    },
  );
  await check("Fleet inventory summary counts", "/api/v1/meters/summary", 200, {
    verify: (b) => {
      assert.equal(b.meta.query_mode, "export_summary");
      assert.ok(b.data.total_meters > 0);
      assert.equal(b.data.total_meters, b.meta.snapshot_total);
      const statusSum = Object.values(b.data.by_installation_status).reduce(
        (a, n) => a + n,
        0,
      );
      const phaseSum = Object.values(b.data.by_phase_type).reduce(
        (a, n) => a + n,
        0,
      );
      const makeSum = Object.values(b.data.by_manufacturer).reduce(
        (a, n) => a + n,
        0,
      );
      assert.equal(statusSum, b.data.total_meters);
      assert.equal(phaseSum, b.data.total_meters);
      assert.equal(makeSum, b.data.total_meters);
    },
  });
  await check("Search exact meter", "/api/v1/meters?q=J100007&page=1", 200, {
    verify: (b) => {
      assert.equal(b.data[0].meter_id, "J100007");
      assert.equal(b.meta.total, 1);
      assert.equal(b.meta.source, "urja_portal");
    },
  });
  await check(
    "Search all pages for exact meter",
    "/api/v1/meters/all?q=J100007",
    200,
    {
      verify: (b) => {
        assert.equal(b.data.length, 1);
        assert.equal(b.data[0].meter_id, "J100007");
        assert.equal(b.meta.total, 1);
        assert.equal(b.meta.returned_count, 1);
        assert.equal(b.meta.pages_fetched, 1);
      },
    },
  );
  await check("Search serial number", "/api/v1/meters?q=SE11409&page=1", 200, {
    verify: (b) => assert.equal(b.data[0].meter_id, "J100007"),
  });
  await check(
    "Search no matches",
    "/api/v1/meters?q=NO_SUCH_METER_TEST&page=1",
    200,
    {
      verify: (b) => {
        assert.deepEqual(b.data, []);
        assert.equal(b.meta.total_pages, 0);
      },
    },
  );
  const pages = [];
  for (const page of [1, 2])
    await check(
      `Search pagination page ${page}`,
      `/api/v1/meters?page=${page}`,
      200,
      {
        verify: (b) => {
          assert.equal(b.meta.page, page);
          assert.equal(b.data.length, 20);
          pages.push(b.data.map((row) => row.meter_id));
          if (pages.length === 2)
            assert.ok(pages[0].every((id) => !pages[1].includes(id)));
        },
      },
    );
  for (const [id, status, serial] of [
    ["J100001", "installed", "GE84132"],
    ["J100020", "installed", "AL20290"],
    ["J100004", "faulty", "SE65293"],
    ["J100007", "decommissioned", "SE11409"],
  ])
    await check(`Nameplate ${id} (${status})`, `/api/v1/meters/${id}`, 200, {
      verify: (b) => {
        assert.equal(b.data.meter_id, id);
        assert.equal(b.data.installation_status, status);
        assert.equal(b.data.serial_number, serial);
      },
    });
  await check(
    "Location coordinates and hierarchy alias",
    "/api/v1/meters/J100400/location",
    200,
    {
      verify: (b) => {
        assert.ok(Math.abs(b.data.coordinates.latitude) <= 90);
        assert.ok(Math.abs(b.data.coordinates.longitude) <= 180);
        assert.deepEqual(b.data.hierarchy.transformer, {
          name: "Old Malviya Nagar Xfmr",
          code: "DT-007",
        });
      },
    },
  );
  await check(
    "Readings sorted, numeric and without invented timezone",
    "/api/v1/meters/J100007/readings",
    200,
    {
      verify: (b) => {
        assert.equal(b.data.length, 337);
        assert.equal(b.meta.returned_count, 337);
        assert.equal(b.meta.timestamp_timezone, null);
        assert.equal(b.meta.available_from, "2026-06-23T23:30:00");
        assert.equal(b.meta.available_to, "2026-06-30T23:30:00");
        for (let i = 0; i < b.data.length; i++) {
          assert.match(
            b.data[i].timestamp,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
          );
          for (const key of [
            "active_energy_kwh",
            "apparent_energy_kvah",
            "voltage_r_v",
          ])
            assert.equal(typeof b.data[i][key], "number");
          if (i) assert.ok(b.data[i - 1].timestamp <= b.data[i].timestamp);
        }
      },
    },
  );
  await check(
    "Readings inclusive date boundaries",
    "/api/v1/meters/J100007/readings?from=2026-06-24T00:00:00&to=2026-06-24T00:30:00",
    200,
    {
      verify: (b) => {
        assert.deepEqual(
          b.data.map((r) => r.timestamp),
          ["2026-06-24T00:00:00", "2026-06-24T00:30:00"],
        );
        assert.equal(b.meta.available_to, "2026-06-30T23:30:00");
      },
    },
  );
  await check(
    "Readings empty filter preserves source availability",
    "/api/v1/meters/J100007/readings?from=2027-01-01T00:00:00",
    200,
    {
      verify: (b) => {
        assert.deepEqual(b.data, []);
        assert.equal(b.meta.returned_count, 0);
        assert.equal(b.meta.available_from, "2026-06-23T23:30:00");
      },
    },
  );
  for (const page of [1, 2])
    await check(
      `Transformer page ${page}`,
      `/api/v1/transformers?page=${page}`,
      200,
      {
        verify: (b) => {
          assert.equal(b.meta.page, page);
          assert.equal(b.meta.total, 40);
          assert.equal(b.data.length, 20);
          assert.equal(typeof b.data[0].capacity_kva, "number");
        },
      },
    );
  for (const suffix of ["", "/location", "/readings"])
    await check(
      `Missing meter ${suffix || "detail"}`,
      `/api/v1/meters/J999999${suffix}`,
      404,
      { verify: (b) => assert.equal(b.error.code, "METER_NOT_FOUND") },
    );
  for (const path of [
    "/api/v1/meters?page=0",
    "/api/v1/meters?page=1&page=2",
    "/api/v1/meters?unexpected=1",
    "/api/v1/meters/bad.id",
    "/api/v1/meters/%E0%A4%A",
    "/api/v1/meters/J100007/readings?from=2026-02-30T00:00:00",
    "/api/v1/meters/J100007/readings?from=2026-06-24T00:00:00Z",
    "/api/v1/meters/J100007/readings?from=2026-06-25T00:00:00&to=2026-06-24T00:00:00",
    "/api/v1/transformers?page=-1",
  ])
    await check(`Invalid input: ${path}`, path, 400);
}
for (const path of [
  "/api/v1/meters",
  "/api/v1/meters/J100007",
  "/api/v1/meters/J100007/location",
  "/api/v1/meters/J100007/readings",
  "/api/v1/transformers",
])
  await check(`Missing session: ${path}`, path, 401, { auth: false });
await check("Rejected session", "/api/v1/meters", 401, {
  auth: false,
  headers: { "X-Urja-Session": "invalid-session-test" },
  verify: (b) => assert.equal(b.error.code, "PORTAL_SESSION_INVALID"),
});
await check("Wrong password", "/api/v1/auth/login", 401, {
  auth: false,
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email,
    password: "deliberately-invalid-test-password",
  }),
  verify: (b) => assert.equal(b.error.code, "INVALID_CREDENTIALS"),
});
await check("Malformed login JSON", "/api/v1/auth/login", 400, {
  auth: false,
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{bad",
});
await check("Unsupported login content type", "/api/v1/auth/login", 415, {
  auth: false,
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: "invalid",
});
await check("Unsupported method", "/api/v1/meters/J100007", 405, {
  method: "POST",
  verify: (_b, r) => assert.equal(r.headers.get("allow"), "GET, HEAD"),
});
await check("Unknown endpoint", "/api/v1/does-not-exist", 404);
if (token) {
  await check("Logout revokes current session", "/api/v1/auth/logout", 200, {
    method: "POST",
    verify: (b) => assert.deepEqual(b.data, { logged_out: true }),
  });
  await check("Logged-out session is rejected", "/api/v1/meters", 401, {
    verify: (b) => assert.equal(b.error.code, "PORTAL_SESSION_INVALID"),
  });
}
const passed = results.filter((r) => r.status === "PASS").length;
const report = `# Live endpoint test report\n\nRun: ${new Date().toISOString()}\n\nTarget: ${origin}\n\n${passed}/${results.length} checks passed. Real HTTP calls to the running API; protected calls reached Urja with the supplied test account. Credentials and session values are not included. Dataset-specific assertions may need updating if the portal data changes.\n\n| Check | Result | HTTP | Duration (ms) |\n| --- | --- | --- | --- |\n${results.map((r) => `| ${r.name.replaceAll("|", "/")} | ${r.status} | ${r.http} | ${r.ms ?? "-"} |`).join("\n")}\n\nAutomated mocked-portal tests separately cover timeouts, malformed source payloads, cookie rotation, caller isolation and login throttling; this live run does not induce upstream outages or expiry.\n`;
await writeFile(new URL("../TEST_REPORT.md", import.meta.url), report);
console.log(
  `${passed}/${results.length} live checks passed; see TEST_REPORT.md.`,
);
if (passed !== results.length) process.exitCode = 1;
