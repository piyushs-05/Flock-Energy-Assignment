import { ApiError } from "./errors.js";
import {
  filterExportedMeters,
  matchExportedRows,
  listRow,
  remapExportWarnings,
  STATUS,
} from "./query.js";

export function transformerCode(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "transformer_code: 1-64 letters, digits, _ or -.",
    );
  return value;
}

export function summarizeTransformerMeters(rows) {
  const by_installation_status = {
    installed: 0,
    faulty: 0,
    decommissioned: 0,
    unknown: 0,
  };
  const by_phase_type = { single: 0, three: 0, unknown: 0 };
  for (const row of rows) {
    const status = STATUS.has(row.installation_status)
      ? row.installation_status
      : "unknown";
    const phase = ["single", "three", "unknown"].includes(row.phase_type)
      ? row.phase_type
      : "unknown";
    by_installation_status[status] += 1;
    by_phase_type[phase] += 1;
  }
  return {
    total_meters: rows.length,
    by_installation_status,
    by_phase_type,
  };
}

export function transformerMeterList(
  exported,
  code,
  { filters, page, page_size },
) {
  const assigned = matchExportedRows(exported, { transformer_code: code });
  const assigned_total = assigned.length;
  const result = filterExportedMeters(exported, {
    filters: { ...filters, transformer_code: code },
    page,
    page_size,
  });
  return {
    data: result.data,
    warnings: result.warnings,
    meta: {
      ...result.meta,
      query_mode: "transformer_meters",
      transformer_code: code,
      assigned_total,
    },
    assigned_total,
  };
}

export function transformerSummaryFromExport(exported, code) {
  const assigned = matchExportedRows(exported, { transformer_code: code });
  const counts = summarizeTransformerMeters(assigned.map((entry) => entry.row));
  return {
    data: {
      transformer_code: code,
      ...counts,
    },
    warnings: remapExportWarnings(exported.warnings, assigned),
    meta: {
      query_mode: "transformer_summary",
      transformer_code: code,
      snapshot_total: exported.meta.total,
      assigned_total: assigned.length,
    },
    assigned_total: assigned.length,
  };
}

export { listRow };
