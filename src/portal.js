import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { Cookie, CookieJar } from "tough-cookie";
import { signExport, normalizeExport } from "./export.js";
import { ApiError, invalidPortalResponse } from "./errors.js";
import { normalizeSearch, SEARCH_ALL_MAX_ROWS } from "./search.js";
import {
  filterExportedMeters,
  nearbyExportedMeters,
  summarizeExportedMeters,
} from "./query.js";
import {
  transformerMeterList,
  transformerSummaryFromExport,
} from "./transformers.js";
import {
  decodeDetail,
  normalizeLocation,
  normalizeReadings,
  normalizeTransformers,
} from "./resources.js";
import {
  Scheduler,
  operationFor,
  timeoutError,
  retryAfter,
  backoff,
} from "./queue.js";

export const SESSION_COOKIE = "__Secure-better-auth.session_token";
export const validSessionValue = (value) =>
  typeof value === "string" &&
  /^[\x21-\x2B\x2D-\x3A\x3C-\x7E]{1,4096}$/.test(value) &&
  !/["\\]/.test(value);

export class PortalClient {
  constructor({
    origin,
    timeoutMs = 10000,
    adapter,
    scheduler = new Scheduler(),
    maxBodyBytes = 1024 * 1024,
    sleep = backoff,
    random = Math.random,
    now = Date.now,
    exportMaxBodyBytes = 5 * 1024 * 1024,
  }) {
    this.origin = new URL(origin).origin;
    this.timeoutMs = timeoutMs;
    this.adapter = adapter;
    this.scheduler = scheduler;
    this.maxBodyBytes = maxBodyBytes;
    this.sleep = sleep;
    this.random = random;
    this.now = now;
    this.exportMaxBodyBytes = exportMaxBodyBytes;
    this.tokens = new WeakMap();
  }

  async client(token) {
    const jar = new CookieJar();
    if (token) {
      if (!validSessionValue(token))
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "Missing or invalid X-Urja-Session.",
        );
      await jar.setCookie(
        new Cookie({
          key: SESSION_COOKIE,
          value: token,
          secure: true,
          httpOnly: true,
          path: "/",
        }),
        this.origin,
      );
    }
    const http = wrapper(
      axios.create({
        baseURL: this.origin,
        jar,
        timeout: this.timeoutMs,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 8192,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(data) => data],
        ...(this.adapter ? { adapter: this.adapter } : {}),
      }),
    );
    if (token) this.tokens.set(http, token);
    return { http, jar };
  }

  async request(http, options) {
    const {
      beforeAttempt,
      bodyLimit = this.maxBodyBytes,
      allowSessionDeletion = false,
      ...requestOptions
    } = options;
    const operation = operationFor(options.signal || http);
    const deadlineSignal = AbortSignal.timeout(
      Math.max(1, operation.deadline - Date.now()),
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadlineSignal])
      : deadlineSignal;
    while (true) {
      if (signal.aborted || Date.now() >= operation.deadline)
        throw timeoutError();
      const release = await this.scheduler.acquire(signal);
      const attempt = new AbortController();
      const attemptTimer = setTimeout(
        () => attempt.abort(),
        Math.max(1, Math.min(this.timeoutMs, operation.deadline - Date.now())),
      );
      attemptTimer.unref();
      let failure;
      try {
        if (signal.aborted) throw timeoutError();
        const response = await http.request({
          ...requestOptions,
          headers: { ...requestOptions.headers, ...beforeAttempt?.() },
          signal: AbortSignal.any([signal, attempt.signal]),
          // axios timeout only covers headers; we bound the streamed body ourselves
          timeout: 0,
          responseType: "stream",
        });
        const chunks = [];
        let bytes = 0;
        try {
          for await (const chunk of response.data) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > bodyLimit)
              throw new ApiError(
                502,
                "PORTAL_RESPONSE_TOO_LARGE",
                "Urja response too large.",
              );
            chunks.push(buffer);
          }
        } finally {
          response.data.destroy();
        }
        response.data = Buffer.concat(chunks).toString("utf8");
        if (!allowSessionDeletion)
          this.checkSession(response, this.tokens.get(http));
        const { status, headers } = response;
        if (
          status === 401 ||
          (status >= 300 &&
            status < 400 &&
            new URL(headers.location || "/", this.origin).pathname === "/login")
        )
          throw new ApiError(
            401,
            "PORTAL_SESSION_INVALID",
            "Session rejected. Sign in again.",
          );
        if (status === 403)
          throw new ApiError(403, "FORBIDDEN", "Urja refused this operation.");
        if (status === 429) {
          const error = new ApiError(
            503,
            "PORTAL_RATE_LIMITED",
            "Urja is rate limiting requests.",
          );
          error.retryAfter = retryAfter(headers["retry-after"]);
          throw error;
        }
        if (status >= 500) {
          const error = new ApiError(
            503,
            "PORTAL_UNAVAILABLE",
            "Urja is temporarily unavailable.",
          );
          error.retryable = [502, 503, 504].includes(status);
          throw error;
        }
        if (status < 200 || status >= 300) throw invalidPortalResponse();
        return response;
      } catch (error) {
        if (signal.aborted) throw timeoutError();
        if (attempt.signal.aborted) {
          failure = timeoutError();
          failure.retryable = true;
        } else if (error instanceof ApiError) failure = error;
        else {
          failure = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code)
            ? new ApiError(
                504,
                "PORTAL_TIMEOUT",
                "Urja did not respond in time.",
              )
            : new ApiError(
                503,
                "PORTAL_UNAVAILABLE",
                "Urja could not be reached.",
              );
          failure.retryable = [
            "ECONNABORTED",
            "ETIMEDOUT",
            "ECONNRESET",
            "EAI_AGAIN",
            "ECONNREFUSED",
          ].includes(error.code);
        }
      } finally {
        clearTimeout(attemptTimer);
        release();
      }
      const waitMs = 250 + Math.floor(this.random() * 251);
      if (
        options.method !== "GET" ||
        !failure.retryable ||
        operation.retries === 0 ||
        Date.now() + waitMs + 1 >= operation.deadline
      )
        throw failure;
      operation.retries--;
      try {
        await this.sleep(waitMs, signal);
      } catch {
        throw timeoutError();
      }
    }
  }

  checkSession(response, token) {
    if (!token) return;
    for (const raw of response.headers["set-cookie"] || []) {
      const cookie = Cookie.parse(raw);
      if (
        cookie?.key === SESSION_COOKIE &&
        (cookie.value !== token || cookie.expiryTime() <= Date.now())
      )
        throw new ApiError(
          401,
          "PORTAL_SESSION_CHANGED",
          "Session changed. Sign in again.",
        );
    }
  }

  async search(token, query, signal) {
    const { http } = await this.client(token);
    const payload = await this.getJson(
      http,
      token,
      "/portal/meters/search",
      signal,
      query,
    );
    return normalizeSearch(payload, query.page);
  }

  async searchAll(token, { q }, signal) {
    const { http } = await this.client(token);
    const data = [];
    const warnings = [];
    const seen = new Set();
    let page = 1;
    let total;
    let pageSize;
    let totalPages;

    while (true) {
      const payload = await this.getJson(
        http,
        token,
        "/portal/meters/search",
        signal,
        { q, page },
      );
      const result = normalizeSearch(payload, page);

      if (total === undefined) {
        ({
          total,
          page_size: pageSize,
          total_pages: totalPages,
        } = result.pagination);
        if (total > SEARCH_ALL_MAX_ROWS)
          throw new ApiError(
            502,
            "PORTAL_RESULT_TOO_LARGE",
            `Search result exceeds the ${SEARCH_ALL_MAX_ROWS}-row limit.`,
          );
      } else if (
        result.pagination.total !== total ||
        result.pagination.page_size !== pageSize ||
        result.pagination.total_pages !== totalPages
      )
        throw invalidPortalResponse();

      for (const row of result.data) {
        if (seen.has(row.meter_id)) throw invalidPortalResponse();
        seen.add(row.meter_id);
        data.push(row);
      }
      warnings.push(...result.warnings);

      if (total === 0 || page >= totalPages) break;
      if (result.data.length === 0) throw invalidPortalResponse();
      page += 1;
    }

    if (data.length !== total) throw invalidPortalResponse();
    return {
      data,
      warnings,
      meta: {
        total,
        returned_count: data.length,
        page_size: pageSize,
        pages_fetched: total === 0 ? 1 : totalPages,
      },
    };
  }

  async getJson(http, token, url, signal, params, transport = {}) {
    const response = await this.request(http, {
      method: "GET",
      url,
      params,
      signal,
      ...transport,
    });
    for (const raw of response.headers["set-cookie"] || []) {
      const cookie = Cookie.parse(raw);
      if (
        cookie?.key === SESSION_COOKIE &&
        (cookie.value !== token ||
          (typeof cookie.maxAge === "number" && cookie.maxAge <= 0) ||
          (cookie.expires instanceof Date && cookie.expires <= new Date()))
      )
        throw new ApiError(
          401,
          "PORTAL_SESSION_CHANGED",
          "Session changed. Sign in again.",
        );
    }
    let payload;
    try {
      payload = JSON.parse(response.data);
    } catch {
      throw invalidPortalResponse();
    }
    return payload;
  }

  async fetchDetail(http, token, id, signal) {
    const payload = await this.getJson(
      http,
      token,
      `/meters/${encodeURIComponent(id)}/__data.json`,
      signal,
      { "x-sveltekit-invalidated": "001" },
    );
    return decodeDetail(payload, id);
  }

  async detail(token, id, signal) {
    const { http } = await this.client(token);
    const result = await this.fetchDetail(http, token, id, signal);
    return { data: result.data, warnings: result.warnings };
  }

  async location(token, id, signal) {
    const { http } = await this.client(token);
    const detail = await this.fetchDetail(http, token, id, signal);
    const geo = await this.getJson(
      http,
      token,
      `/portal/meters/${encodeURIComponent(id)}/geo`,
      signal,
    );
    const result = normalizeLocation(detail, geo);
    return { ...result, warnings: [...detail.warnings, ...result.warnings] };
  }

  async readings(token, id, query, signal) {
    const { http } = await this.client(token);
    await this.fetchDetail(http, token, id, signal);
    const payload = await this.getJson(
      http,
      token,
      `/portal/meters/${encodeURIComponent(id)}/energy`,
      signal,
    );
    return normalizeReadings(id, payload, query);
  }

  async transformers(token, page, signal) {
    const { http } = await this.client(token);
    const payload = await this.getJson(http, token, "/portal/dts", signal, {
      page,
    });
    return normalizeTransformers(payload, page);
  }

  async exportMeters(token, signal) {
    const { http } = await this.client(token);
    const keys = await this.getJson(http, token, "/portal/keys", signal);
    const secret = keys?.data?.signingSecret;
    if (
      typeof secret !== "string" ||
      secret.length === 0 ||
      Buffer.byteLength(secret) > 8192
    )
      throw invalidPortalResponse();
    const payload = await this.getJson(
      http,
      token,
      "/portal/export?page=1",
      signal,
      undefined,
      {
        bodyLimit: this.exportMaxBodyBytes,
        beforeAttempt: () => signExport(secret, this.now()),
      },
    );
    return normalizeExport(payload);
  }

  async queryMeters(token, query, signal) {
    const exported = await this.exportMeters(token, signal);
    return filterExportedMeters(exported, query);
  }

  async nearbyMeters(token, query, signal) {
    const exported = await this.exportMeters(token, signal);
    return nearbyExportedMeters(exported, query);
  }

  async metersSummary(token, signal) {
    const exported = await this.exportMeters(token, signal);
    return summarizeExportedMeters(exported);
  }

  async catalogueHasTransformer(token, code, signal) {
    const { http } = await this.client(token);
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const payload = await this.getJson(http, token, "/portal/dts", signal, {
        page,
      });
      const result = normalizeTransformers(payload, page);
      if (result.data.some((row) => row.code === code)) return true;
      totalPages = Math.max(1, result.meta.total_pages);
      if (result.meta.total === 0) return false;
      page += 1;
    }
    return false;
  }

  async ensureTransformerKnown(token, code, assignedTotal, signal) {
    if (assignedTotal > 0) return;
    const exists = await this.catalogueHasTransformer(token, code, signal);
    if (!exists)
      throw new ApiError(
        404,
        "TRANSFORMER_NOT_FOUND",
        "Transformer not found.",
      );
  }

  async transformerMeters(token, code, query, signal) {
    const exported = await this.exportMeters(token, signal);
    const { data, warnings, meta, assigned_total } = transformerMeterList(
      exported,
      code,
      query,
    );
    await this.ensureTransformerKnown(token, code, assigned_total, signal);
    return { data, warnings, meta };
  }

  async transformerSummary(token, code, signal) {
    const exported = await this.exportMeters(token, signal);
    const { data, warnings, meta, assigned_total } =
      transformerSummaryFromExport(exported, code);
    await this.ensureTransformerKnown(token, code, assigned_total, signal);
    return { data, warnings, meta };
  }

  async overview(token, id, signal) {
    const { http } = await this.client(token);
    const detail = await this.fetchDetail(http, token, id, signal);
    const geo = await this.getJson(
      http,
      token,
      `/portal/meters/${encodeURIComponent(id)}/geo`,
      signal,
    );
    const location = normalizeLocation(detail, geo);
    const energy = await this.getJson(
      http,
      token,
      `/portal/meters/${encodeURIComponent(id)}/energy`,
      signal,
    );
    const readings = normalizeReadings(id, energy, {});
    const latest = readings.meta.available_to;
    const latest_readings = latest
      ? readings.data.filter((row) => row.timestamp === latest)
      : [];
    const {
      serial_number,
      manufacturer,
      phase_type,
      installation_status,
      installation_type,
    } = detail.data;
    return {
      data: {
        meter_id: id,
        nameplate: {
          serial_number,
          manufacturer,
          phase_type,
          installation_status,
          installation_type,
        },
        location: {
          coordinates: location.data.coordinates,
          hierarchy: location.data.hierarchy,
        },
        readings_summary: {
          available_from: readings.meta.available_from,
          available_to: readings.meta.available_to,
          reading_count: readings.data.length,
          timestamp_timezone: readings.meta.timestamp_timezone,
          latest_readings,
        },
      },
      warnings: [
        ...detail.warnings,
        ...location.warnings,
        ...readings.warnings,
      ],
      meta: {
        composite: true,
        note: "Combined from separate portal reads; not an atomic snapshot.",
      },
    };
  }

  async login({ email, password }, signal) {
    const { http, jar } = await this.client();
    let response;
    try {
      response = await this.request(http, {
        method: "POST",
        url: "/login",
        data: new URLSearchParams({ email, password }).toString(),
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: this.origin,
          Referer: `${this.origin}/login`,
        },
      });
    } catch (error) {
      if (error.code === "PORTAL_SESSION_INVALID")
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Invalid email or password.",
        );
      throw error;
    }
    const cookie = (await jar.getCookies(this.origin)).find(
      (item) => item.key === SESSION_COOKIE,
    );
    if (!cookie || !validSessionValue(cookie.value)) {
      let rejected = false;
      try {
        const body = JSON.parse(response.data);
        rejected = body?.type === "failure" && body?.status === 401;
      } catch {
        /* ignore non-JSON login body */
      }
      if (rejected)
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Invalid email or password.",
        );
      throw new ApiError(
        502,
        "PORTAL_AUTH_UNSUPPORTED",
        "Urja did not issue the expected session cookie.",
      );
    }
    await this.search(cookie.value, { q: "", page: 1 }, signal);
    const expiry = cookie.expiryTime();
    return {
      session_token: cookie.value,
      expires_at: Number.isFinite(expiry)
        ? new Date(expiry).toISOString()
        : null,
    };
  }

  async logout(token, signal) {
    const { http } = await this.client(token);
    const response = await this.request(http, {
      method: "POST",
      url: "/api/auth/sign-out",
      signal,
      allowSessionDeletion: true,
      headers: {
        Origin: this.origin,
        Referer: `${this.origin}/meters`,
      },
    });
    let payload;
    try {
      payload = JSON.parse(response.data);
    } catch {
      throw invalidPortalResponse();
    }
    const cleared = (response.headers["set-cookie"] || []).some((raw) => {
      const cookie = Cookie.parse(raw);
      return (
        cookie?.key === SESSION_COOKIE &&
        (cookie.value === "" ||
          (typeof cookie.maxAge === "number" && cookie.maxAge <= 0) ||
          (cookie.expires instanceof Date && cookie.expires <= new Date()))
      );
    });
    if (payload?.success !== true || !cleared) throw invalidPortalResponse();
    return { data: { logged_out: true } };
  }
}
