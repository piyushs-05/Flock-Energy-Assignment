import { unflatten } from "devalue";
import { z } from "zod";
import { ApiError, invalidPortalResponse } from "./errors.js";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => {
  throw invalidPortalResponse();
};
export const warning = (field, message, source_value) => ({
  code: "SOURCE_DATA_WARNING",
  field,
  message,
  ...(source_value === undefined ? {} : { source_value }),
});
export const categories = {
  phase_type: { single: "single", three: "three" },
  installation_status: {
    Installed: "installed",
    Faulty: "faulty",
    Decommissioned: "decommissioned",
  },
  installation_type: {
    "CT Operated": "ct_operated",
    "Whole Current": "whole_current",
  },
};
export function mapCategory(field, value, warnings, path = field) {
  if (Object.hasOwn(categories[field], value)) return categories[field][value];
  warnings.push(warning(path, "Unrecognized source category.", value));
  return "unknown";
}
const labels = {
  "Meter ID": "MeterId",
  "Serial No": "SerialNo",
  Make: "Make",
  "Phase Type": "PhaseType",
  "Installation Status": "InstallationStatus",
  "Installation Type": "InstallationType",
};
const nameplate = z.object(
  Object.fromEntries(
    Object.values(labels).map((key) => [key, z.string().min(1)]),
  ),
);

export function meterId(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "meter_id: 1-64 letters, digits, _ or -.",
    );
  return value;
}

export function parseQuery(query, allowed = []) {
  if (
    Object.keys(query).some((key) => !allowed.includes(key)) ||
    Object.values(query).some((value) => typeof value !== "string")
  )
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Unknown or repeated query parameters.",
    );
  return query;
}

export function parsePage(query) {
  parseQuery(query, ["page"]);
  const value = query.page ?? "1";
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 1000000
  )
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "page must be a positive integer (max 1000000).",
    );
  return Number(value);
}

export function decodeDetail(payload, id) {
  if (
    !object(payload) ||
    payload.type !== "data" ||
    !Array.isArray(payload.nodes)
  )
    fail();
  const candidates = [];
  let missing = false;
  for (const node of payload.nodes) {
    if (!object(node)) fail();
    if (node.type === "skip") continue;
    if (node.type === "error") {
      if (node.status === 404 && node.error?.message === "Meter not found") {
        missing = true;
        continue;
      }
      fail();
    }
    if (node.type !== "data" || !Array.isArray(node.data)) fail();
    let decoded;
    try {
      decoded = unflatten(node.data);
    } catch {
      fail();
    }
    if (object(decoded) && ("meterId" in decoded || "detail" in decoded))
      candidates.push(decoded);
  }
  if (missing && candidates.length === 0)
    throw new ApiError(404, "METER_NOT_FOUND", "Meter not found.");
  if (missing || candidates.length !== 1) fail();
  const decoded = candidates[0];
  if (decoded.meterId !== id || !object(decoded.detail)) fail();
  let fields;
  if (
    Array.isArray(decoded.detail.data) &&
    !Object.hasOwn(decoded.detail, "classData")
  ) {
    fields = Object.create(null);
    for (const pair of decoded.detail.data) {
      if (
        !object(pair) ||
        typeof pair.parameterName !== "string" ||
        typeof pair.parameterValue !== "string"
      )
        fail();
      if (!Object.hasOwn(labels, pair.parameterName)) continue;
      const key = labels[pair.parameterName];
      if (Object.hasOwn(fields, key) && fields[key] !== pair.parameterValue)
        fail();
      fields[key] = pair.parameterValue;
    }
  } else if (
    typeof decoded.detail.classData === "string" &&
    !Object.hasOwn(decoded.detail, "data")
  ) {
    try {
      fields = JSON.parse(decoded.detail.classData)?.installed_meter;
    } catch {
      fail();
    }
  } else fail();
  const parsed = nameplate.safeParse(fields);
  if (!parsed.success || parsed.data.MeterId !== id) fail();
  const hierarchy = decoded.hierarchy;
  if (hierarchy != null && !object(hierarchy)) fail();
  if (
    hierarchy &&
    Object.hasOwn(hierarchy, "Meter ID") &&
    hierarchy["Meter ID"] !== id
  )
    fail();
  for (const [key, field] of [
    ["Installation Status", "InstallationStatus"],
    ["Installation Type", "InstallationType"],
  ]) {
    if (
      hierarchy &&
      Object.hasOwn(hierarchy, key) &&
      hierarchy[key] !== parsed.data[field]
    )
      fail();
  }
  const result = normalizeNameplate(parsed.data);
  return { ...result, hierarchy };
}

export function normalizeNameplate(fields) {
  const parsed = nameplate.safeParse(fields);
  if (!parsed.success) fail();
  const warnings = [];
  const f = parsed.data;
  return {
    data: {
      meter_id: f.MeterId,
      serial_number: f.SerialNo,
      manufacturer: f.Make,
      phase_type: mapCategory("phase_type", f.PhaseType, warnings),
      installation_status: mapCategory(
        "installation_status",
        f.InstallationStatus,
        warnings,
      ),
      installation_type: mapCategory(
        "installation_type",
        f.InstallationType,
        warnings,
      ),
    },
    warnings,
  };
}

function finiteNumber(value) {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    fail();
  }
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  )
    fail();
  const number = Number(value);
  if (!Number.isFinite(number)) fail();
  return number;
}

export function normalizeLocation(detail, payload) {
  if (
    !object(payload) ||
    !Object.hasOwn(payload, "data") ||
    (payload.data !== null && !object(payload.data))
  )
    fail();
  const warnings = [];
  const coordinates = {};
  for (const [field, limit] of [
    ["latitude", 90],
    ["longitude", 180],
  ]) {
    const value = payload.data?.[field];
    if (value == null || value === "") {
      coordinates[field] = null;
      warnings.push(warning(`coordinates.${field}`, "Coordinate is absent."));
    } else {
      const number = finiteNumber(value);
      if (Math.abs(number) > limit) fail();
      coordinates[field] = number;
    }
  }
  const hierarchy = {};
  for (const [field, key] of Object.entries({
    zone: "Zone",
    circle: "Circle",
    division: "Division",
    subdivision: "Subdivision",
    substation: "Sub Station",
    feeder: "Feeder",
    transformer: "DT",
  })) {
    const value = detail.hierarchy?.[key];
    if (value == null || value === "") {
      hierarchy[field] = null;
      warnings.push(
        warning(`hierarchy.${field}`, "Hierarchy level is absent."),
      );
    } else {
      if (typeof value !== "string") fail();
      const match = /^(.*?)\s+\(([^()]+)\)$/.exec(value);
      hierarchy[field] =
        match && match[1].trim()
          ? { name: match[1].trim(), code: match[2] }
          : { name: value, code: null };
      if (!hierarchy[field].code)
        warnings.push(
          warning(
            `hierarchy.${field}`,
            "Hierarchy code could not be parsed.",
            value,
          ),
        );
    }
  }
  return {
    data: { meter_id: detail.data.meter_id, coordinates, hierarchy },
    warnings,
  };
}

export function validLocalTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

export function parseReadingQuery(query) {
  parseQuery(query, ["from", "to"]);
  if (
    Object.values(query).some((value) => !validLocalTimestamp(value)) ||
    (query.from && query.to && query.from > query.to)
  )
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "from/to must be YYYY-MM-DDTHH:mm:ss (no timezone), with from <= to.",
    );
  return query;
}

export function normalizeReadings(id, payload, { from, to }) {
  if (!object(payload) || !Array.isArray(payload.data)) fail();
  const warnings = [];
  const seen = new Set();
  const readings = payload.data
    .map((row) => {
      if (!object(row) || typeof row.timestamp !== "string") fail();
      const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(
        row.timestamp,
      );
      if (!match) fail();
      const timestamp = `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00`;
      if (!validLocalTimestamp(timestamp)) fail();
      if (seen.has(timestamp))
        warnings.push(
          warning(
            "timestamp",
            "Duplicate source timestamp preserved.",
            timestamp,
          ),
        );
      seen.add(timestamp);
      return {
        timestamp,
        active_energy_kwh: finiteNumber(row.kwh),
        apparent_energy_kvah: finiteNumber(row.kvah),
        voltage_r_v: finiteNumber(row.voltR),
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const data = readings.filter(
    (row) => (!from || row.timestamp >= from) && (!to || row.timestamp <= to),
  );
  return {
    data,
    warnings,
    meta: {
      meter_id: id,
      timestamp_timezone: null,
      available_from: readings[0]?.timestamp ?? null,
      available_to: readings.at(-1)?.timestamp ?? null,
      returned_count: data.length,
    },
  };
}

export function normalizeTransformers(payload, requestedPage) {
  const schema = z.object({
    data: z.array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        feederCode: z.string().min(1),
        capacityKva: z.number().finite().nonnegative(),
      }),
    ),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) fail();
  const { data, page, pageSize, total } = parsed.data;
  if (
    page !== requestedPage ||
    data.length > pageSize ||
    data.length > total ||
    new Set(data.map((row) => row.code)).size !== data.length
  )
    fail();
  return {
    data: data.map((row) => ({
      code: row.code,
      name: row.name,
      feeder_code: row.feederCode,
      capacity_kva: row.capacityKva,
    })),
    warnings: [],
    meta: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
  };
}
