import { z } from "zod";
import { ApiError, invalidPortalResponse } from "./errors.js";
import { mapCategory } from "./resources.js";

const integer = z.number().int().nonnegative();
const payloadSchema = z.object({
  data: z.array(
    z.object({
      meterId: z.string().min(1),
      serialNo: z.string(),
      make: z.string(),
      phaseType: z.string(),
      installStatus: z.string(),
      dtCode: z.string(),
    }),
  ),
  total: integer,
  page: integer.positive(),
  pageSize: integer.positive(),
});

export function parseSearch(query) {
  const parsed = z
    .object({
      q: z.string().trim().max(200).default(""),
      page: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().max(1000000))
        .default(1),
    })
    .strict()
    .safeParse(query);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Use q (max 200 chars) and a positive integer page.",
    );
  return parsed.data;
}

/** q only — /meters/all walks pages itself. */
export function parseSearchAll(query) {
  const parsed = z
    .object({
      q: z.string().trim().max(200).default(""),
    })
    .strict()
    .safeParse(query);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Use q only (max 200 chars). Pages are fetched automatically.",
    );
  return parsed.data;
}

export const SEARCH_ALL_MAX_ROWS = 10000;

export function normalizeSearch(payload, requestedPage) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw invalidPortalResponse();
  const { data, total, page, pageSize } = parsed.data;
  if (
    page !== requestedPage ||
    data.length > pageSize ||
    data.length > total ||
    new Set(data.map((row) => row.meterId)).size !== data.length
  )
    throw invalidPortalResponse();
  const warnings = [];
  return {
    data: data.map((row) => ({
      meter_id: row.meterId,
      serial_number: row.serialNo,
      manufacturer: row.make,
      phase_type: mapCategory("phase_type", row.phaseType, warnings),
      installation_status: mapCategory(
        "installation_status",
        row.installStatus,
        warnings,
      ),
      transformer_code: row.dtCode,
    })),
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
    warnings,
  };
}
