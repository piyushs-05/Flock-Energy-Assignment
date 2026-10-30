import { createHmac } from "node:crypto";
import { z } from "zod";
import { invalidPortalResponse, ApiError } from "./errors.js";
import { normalizeNameplate, normalizeLocation } from "./resources.js";

export function signExport(secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const message = ["GET", "/portal/export", "page=1", timestamp].join("\n");
  return {
    "x-timestamp": timestamp,
    "x-signature": createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(message, "utf8")
      .digest("hex"),
  };
}

const entry = z
  .object({ name: z.string(), code: z.string() })
  .nullable()
  .optional();
const rowSchema = z.object({
  meterId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  serialNo: z.string().min(1),
  make: z.string().min(1),
  phaseType: z.string().min(1),
  installStatus: z.string().min(1),
  installType: z.string().min(1),
  dtCode: z.string().min(1),
  hierarchy: z.object({
    zone: entry,
    circle: entry,
    division: entry,
    subdivision: entry,
    substation: entry,
    feeder: entry,
    dt: entry,
  }),
  geo: z
    .object({
      lat: z.number().finite().nullable().optional(),
      lng: z.number().finite().nullable().optional(),
    })
    .nullable(),
});

export function normalizeExport(payload) {
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    !Number.isSafeInteger(payload.total) ||
    payload.total < 0 ||
    payload.total !== payload.data.length
  )
    throw invalidPortalResponse();
  if (payload.data.length > 10000)
    throw new ApiError(
      502,
      "PORTAL_EXPORT_TOO_LARGE",
      "Export exceeds the 10000-row limit.",
    );
  const seen = new Set();
  const warnings = [];
  const data = payload.data.map((raw, index) => {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) throw invalidPortalResponse();
    const row = parsed.data;
    if (
      seen.has(row.meterId) ||
      (row.hierarchy.dt?.code && row.hierarchy.dt.code !== row.dtCode)
    )
      throw invalidPortalResponse();
    seen.add(row.meterId);
    const plate = normalizeNameplate({
      MeterId: row.meterId,
      SerialNo: row.serialNo,
      Make: row.make,
      PhaseType: row.phaseType,
      InstallationStatus: row.installStatus,
      InstallationType: row.installType,
    });
    const location = normalizeLocation(
      { data: plate.data, hierarchy: {} },
      {
        data:
          row.geo === null
            ? null
            : { latitude: row.geo.lat, longitude: row.geo.lng },
      },
    );
    location.warnings = location.warnings.filter(
      (w) => !w.field.startsWith("hierarchy."),
    );
    for (const [key, field] of Object.entries({
      zone: "zone",
      circle: "circle",
      division: "division",
      subdivision: "subdivision",
      substation: "substation",
      feeder: "feeder",
      dt: "transformer",
    })) {
      const value = row.hierarchy[key];
      location.data.hierarchy[field] = value
        ? { name: value.name, code: value.code || null }
        : null;
      if (!value || !value.name || !value.code)
        location.warnings.push({
          code: "SOURCE_DATA_WARNING",
          field: `hierarchy.${field}`,
          message: "Hierarchy name or code missing.",
        });
    }
    warnings.push(
      ...[...plate.warnings, ...location.warnings].map((warning) => ({
        ...warning,
        field: `data.${index}.${warning.field}`,
      })),
    );
    return {
      ...plate.data,
      transformer_code: row.dtCode,
      coordinates: location.data.coordinates,
      hierarchy: location.data.hierarchy,
    };
  });
  return {
    data,
    warnings,
    meta: { total: payload.total, returned_count: data.length },
  };
}
