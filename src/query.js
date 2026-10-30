import { ApiError } from "./errors.js";
import { parseQuery } from "./resources.js";

export const STATUS = new Set([
  "installed",
  "faulty",
  "decommissioned",
  "unknown",
]);
const PHASE = new Set(["single", "three", "unknown"]);
const INSTALL = new Set(["ct_operated", "whole_current", "unknown"]);

function positiveInt(value, name, { max, fallback }) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `${name} must be an integer from 1 to ${max}.`,
    );
  return Number(value);
}

function finiteNumber(value, name, { min, max }) {
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
  )
    throw new ApiError(400, "INVALID_REQUEST", `${name} must be a number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `${name} must be between ${min} and ${max}.`,
    );
  return number;
}

function parseStatus(value) {
  if (!STATUS.has(value))
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "status must be installed, faulty, decommissioned, or unknown.",
    );
  return value;
}

function parseFilters(query, { requireOne }) {
  const filters = {};
  if (query.status !== undefined) filters.status = parseStatus(query.status);
  if (query.phase_type !== undefined) {
    if (!PHASE.has(query.phase_type))
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "phase_type must be single, three, or unknown.",
      );
    filters.phase_type = query.phase_type;
  }
  if (query.transformer_code !== undefined) {
    if (!query.transformer_code.trim())
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "transformer_code cannot be empty.",
      );
    filters.transformer_code = query.transformer_code.trim();
  }
  if (query.manufacturer !== undefined) {
    if (!query.manufacturer.trim() || query.manufacturer.length > 200)
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "manufacturer must be 1-200 characters.",
      );
    filters.manufacturer = query.manufacturer.trim();
  }
  if (query.installation_type !== undefined) {
    if (!INSTALL.has(query.installation_type))
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "installation_type must be ct_operated, whole_current, or unknown.",
      );
    filters.installation_type = query.installation_type;
  }
  if (requireOne && Object.keys(filters).length === 0)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Provide at least one filter: status, phase_type, transformer_code, manufacturer, or installation_type.",
    );
  return filters;
}

export function parseMeterQuery(query) {
  parseQuery(query, [
    "status",
    "phase_type",
    "transformer_code",
    "manufacturer",
    "installation_type",
    "page",
    "page_size",
  ]);
  return {
    filters: parseFilters(query, { requireOne: true }),
    page: positiveInt(query.page, "page", { max: 1000000, fallback: 1 }),
    page_size: positiveInt(query.page_size, "page_size", {
      max: 100,
      fallback: 20,
    }),
  };
}

export function parseTransformerMetersQuery(query) {
  parseQuery(query, ["status", "page", "page_size"]);
  return {
    filters: parseFilters(query, { requireOne: false }),
    page: positiveInt(query.page, "page", { max: 1000000, fallback: 1 }),
    page_size: positiveInt(query.page_size, "page_size", {
      max: 100,
      fallback: 20,
    }),
  };
}

export function parseNearbyQuery(query) {
  parseQuery(query, ["latitude", "longitude", "radius_m", "limit"]);
  if (query.latitude === undefined || query.longitude === undefined)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "latitude and longitude are required.",
    );
  return {
    latitude: finiteNumber(query.latitude, "latitude", { min: -90, max: 90 }),
    longitude: finiteNumber(query.longitude, "longitude", {
      min: -180,
      max: 180,
    }),
    radius_m: positiveInt(query.radius_m, "radius_m", {
      max: 50000,
      fallback: 1000,
    }),
    limit: positiveInt(query.limit, "limit", { max: 200, fallback: 50 }),
  };
}

/** Great-circle distance in meters. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function listRow(row) {
  return {
    meter_id: row.meter_id,
    serial_number: row.serial_number,
    manufacturer: row.manufacturer,
    phase_type: row.phase_type,
    installation_status: row.installation_status,
    installation_type: row.installation_type,
    transformer_code: row.transformer_code,
    coordinates: row.coordinates,
  };
}

export function rowMatchesFilters(row, filters) {
  if (filters.status && row.installation_status !== filters.status)
    return false;
  if (filters.phase_type && row.phase_type !== filters.phase_type) return false;
  if (
    filters.transformer_code &&
    row.transformer_code !== filters.transformer_code
  )
    return false;
  if (
    filters.manufacturer &&
    row.manufacturer.toLowerCase() !== filters.manufacturer.toLowerCase()
  )
    return false;
  if (
    filters.installation_type &&
    row.installation_type !== filters.installation_type
  )
    return false;
  return true;
}

/** Filter → sort by meter_id. Returns { row, exportIndex }[]. */
export function matchExportedRows(exported, filters) {
  const matched = [];
  for (let index = 0; index < exported.data.length; index++) {
    const row = exported.data[index];
    if (rowMatchesFilters(row, filters))
      matched.push({ row, exportIndex: index });
  }
  matched.sort((a, b) => a.row.meter_id.localeCompare(b.row.meter_id));
  return matched;
}

export function remapExportWarnings(exportedWarnings, pageEntries) {
  const byIndex = new Map(
    pageEntries.map((entry) => [entry.exportIndex, entry.row.meter_id]),
  );
  const warnings = [];
  for (const item of exportedWarnings || []) {
    const match = /^data\.(\d+)\.(.+)$/.exec(item.field || "");
    if (!match) {
      warnings.push(item);
      continue;
    }
    const meterId = byIndex.get(Number(match[1]));
    if (!meterId) continue;
    warnings.push({
      ...item,
      field: `meters.${meterId}.${match[2]}`,
    });
  }
  return warnings;
}

export function filterExportedMeters(exported, { filters, page, page_size }) {
  const matched = matchExportedRows(exported, filters);
  const total = matched.length;
  const total_pages = total === 0 ? 0 : Math.ceil(total / page_size);
  const start = (page - 1) * page_size;
  const pageEntries = matched.slice(start, start + page_size);
  return {
    data: pageEntries.map((entry) => listRow(entry.row)),
    warnings: remapExportWarnings(exported.warnings, pageEntries),
    meta: {
      query_mode: "export_filter",
      snapshot_total: exported.meta.total,
      matched_total: total,
      page,
      page_size,
      total_pages,
      filters,
    },
  };
}

/** Fleet inventory counts from one validated export. One pass; each bucket sums to total. */
export function summarizeExportedMeters(exported) {
  const by_installation_status = {
    installed: 0,
    faulty: 0,
    decommissioned: 0,
    unknown: 0,
  };
  const by_phase_type = { single: 0, three: 0, unknown: 0 };
  const by_manufacturer = {};
  const entries = [];
  for (let index = 0; index < exported.data.length; index++) {
    const row = exported.data[index];
    entries.push({ row, exportIndex: index });
    const status = STATUS.has(row.installation_status)
      ? row.installation_status
      : "unknown";
    const phase = PHASE.has(row.phase_type) ? row.phase_type : "unknown";
    const manufacturer =
      typeof row.manufacturer === "string" && row.manufacturer.trim()
        ? row.manufacturer.trim()
        : "unknown";
    by_installation_status[status] += 1;
    by_phase_type[phase] += 1;
    by_manufacturer[manufacturer] = (by_manufacturer[manufacturer] || 0) + 1;
  }
  return {
    data: {
      total_meters: exported.data.length,
      by_installation_status,
      by_phase_type,
      by_manufacturer,
    },
    warnings: remapExportWarnings(exported.warnings, entries),
    meta: {
      query_mode: "export_summary",
      snapshot_total: exported.meta.total,
    },
  };
}

export function nearbyExportedMeters(
  exported,
  { latitude, longitude, radius_m, limit },
) {
  let excluded_missing_coordinates = 0;
  const inside = [];
  for (const row of exported.data) {
    const { latitude: lat, longitude: lng } = row.coordinates || {};
    if (lat == null || lng == null) {
      excluded_missing_coordinates += 1;
      continue;
    }
    const distance_m = distanceMeters(latitude, longitude, lat, lng);
    if (distance_m <= radius_m)
      inside.push({
        ...listRow(row),
        distance_m: Math.round(distance_m * 10) / 10,
      });
  }
  inside.sort(
    (a, b) =>
      a.distance_m - b.distance_m || a.meter_id.localeCompare(b.meter_id),
  );
  const matched_within_radius = inside.length;
  const data = inside.slice(0, limit);
  return {
    data,
    warnings:
      excluded_missing_coordinates > 0
        ? [
            {
              code: "SOURCE_DATA_WARNING",
              field: "coordinates",
              message: `${excluded_missing_coordinates} meters skipped because coordinates are missing.`,
              source_value: String(excluded_missing_coordinates),
            },
          ]
        : [],
    meta: {
      query_mode: "export_nearby",
      snapshot_total: exported.meta.total,
      latitude,
      longitude,
      radius_m,
      limit,
      matched_within_radius,
      returned_count: data.length,
      excluded_missing_coordinates,
    },
  };
}
