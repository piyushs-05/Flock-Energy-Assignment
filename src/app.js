import express from "express";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { parseSearch, parseSearchAll } from "./search.js";
import {
  parseMeterQuery,
  parseNearbyQuery,
  parseTransformerMetersQuery,
} from "./query.js";
import { transformerCode } from "./transformers.js";
import { validSessionValue } from "./portal.js";
import {
  meterId,
  parsePage,
  parseQuery,
  parseReadingQuery,
} from "./resources.js";
import { operationFor } from "./queue.js";

function authenticate(req, res, next) {
  const token = req.get("X-Urja-Session");
  if (!validSessionValue(token))
    return next(
      new ApiError(401, "UNAUTHORIZED", "Missing or invalid X-Urja-Session."),
    );
  req.sessionToken = token;
  next();
}

function sendResource(req, res, result) {
  res.json({
    data: result.data,
    meta: {
      request_id: req.requestId,
      source: "urja_portal",
      fetched_at: new Date().toISOString(),
      ...result.meta,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    },
  });
}

const spec = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
);
const loginSchema = z
  .object({
    email: z.string().trim().pipe(z.email()).pipe(z.string().max(254)),
    password: z.string().min(1).max(1024),
  })
  .strict();

export function createApp({
  portal,
  logger,
  timeoutMs = 30000,
  loginLimit = 5,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-ID", req.requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const start = performance.now();
    res.on("finish", () =>
      logger.info(
        {
          request_id: req.requestId,
          method: req.method,
          route: req.route?.path || "unmatched",
          status: res.statusCode,
          duration_ms: Math.round(performance.now() - start),
        },
        "Request completed",
      ),
    );
    next();
  });
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/openapi.json", (req, res) => res.json(spec));
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      swaggerOptions: { persistAuthorization: false, validatorUrl: null },
      customSiteTitle: "Urja Meter API",
    }),
  );
  app.use("/api", (req, res, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    req.portalSignal = controller.signal;
    operationFor(controller.signal, timeoutMs);
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) controller.abort();
    });
    next();
  });
  app.post(
    "/api/v1/auth/login",
    rateLimit({
      windowMs: 60000,
      limit: loginLimit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (req, res, next) =>
        next(
          new ApiError(
            429,
            "RATE_LIMITED",
            "Too many login attempts. Try again later.",
          ),
        ),
    }),
    (req, res, next) => {
      if (!req.is("application/json"))
        return next(
          new ApiError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Login requires application/json.",
          ),
        );
      next();
    },
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success)
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Need a valid email and nonempty password.",
        );
      const data = await portal.login(parsed.data, req.portalSignal);
      res.json({ data, meta: { request_id: req.requestId } });
    },
  );
  app.post("/api/v1/auth/logout", authenticate, async (req, res) => {
    parseQuery(req.query);
    sendResource(
      req,
      res,
      await portal.logout(req.sessionToken, req.portalSignal),
    );
  });
  app.get("/api/v1/meters", authenticate, async (req, res) => {
    const query = parseSearch(req.query);
    const result = await portal.search(
      req.sessionToken,
      query,
      req.portalSignal,
    );
    sendResource(req, res, {
      data: result.data,
      meta: result.pagination,
      warnings: result.warnings,
    });
  });
  app.get("/api/v1/meters/all", authenticate, async (req, res) => {
    const query = parseSearchAll(req.query);
    sendResource(
      req,
      res,
      await portal.searchAll(req.sessionToken, query, req.portalSignal),
    );
  });
  app.get("/api/v1/meters/export", authenticate, async (req, res) => {
    parseQuery(req.query);
    sendResource(
      req,
      res,
      await portal.exportMeters(req.sessionToken, req.portalSignal),
    );
  });
  app.get("/api/v1/meters/query", authenticate, async (req, res) => {
    const query = parseMeterQuery(req.query);
    sendResource(
      req,
      res,
      await portal.queryMeters(req.sessionToken, query, req.portalSignal),
    );
  });
  app.get("/api/v1/meters/nearby", authenticate, async (req, res) => {
    const query = parseNearbyQuery(req.query);
    sendResource(
      req,
      res,
      await portal.nearbyMeters(req.sessionToken, query, req.portalSignal),
    );
  });
  app.get("/api/v1/meters/:meter_id", authenticate, async (req, res) => {
    const id = meterId(req.params.meter_id);
    parseQuery(req.query);
    sendResource(
      req,
      res,
      await portal.detail(req.sessionToken, id, req.portalSignal),
    );
  });
  app.get(
    "/api/v1/meters/:meter_id/overview",
    authenticate,
    async (req, res) => {
      const id = meterId(req.params.meter_id);
      parseQuery(req.query);
      sendResource(
        req,
        res,
        await portal.overview(req.sessionToken, id, req.portalSignal),
      );
    },
  );
  app.get(
    "/api/v1/meters/:meter_id/location",
    authenticate,
    async (req, res) => {
      const id = meterId(req.params.meter_id);
      parseQuery(req.query);
      sendResource(
        req,
        res,
        await portal.location(req.sessionToken, id, req.portalSignal),
      );
    },
  );
  app.get(
    "/api/v1/meters/:meter_id/readings",
    authenticate,
    async (req, res) => {
      const id = meterId(req.params.meter_id);
      const query = parseReadingQuery(req.query);
      sendResource(
        req,
        res,
        await portal.readings(req.sessionToken, id, query, req.portalSignal),
      );
    },
  );
  app.get("/api/v1/transformers", authenticate, async (req, res) => {
    const page = parsePage(req.query);
    sendResource(
      req,
      res,
      await portal.transformers(req.sessionToken, page, req.portalSignal),
    );
  });
  app.get(
    "/api/v1/transformers/:transformer_code/meters",
    authenticate,
    async (req, res) => {
      const code = transformerCode(req.params.transformer_code);
      const query = parseTransformerMetersQuery(req.query);
      sendResource(
        req,
        res,
        await portal.transformerMeters(
          req.sessionToken,
          code,
          query,
          req.portalSignal,
        ),
      );
    },
  );
  app.get(
    "/api/v1/transformers/:transformer_code/summary",
    authenticate,
    async (req, res) => {
      const code = transformerCode(req.params.transformer_code);
      parseQuery(req.query);
      sendResource(
        req,
        res,
        await portal.transformerSummary(
          req.sessionToken,
          code,
          req.portalSignal,
        ),
      );
    },
  );
  for (const [path, allow] of [
    ["/health", "GET, HEAD"],
    ["/openapi.json", "GET, HEAD"],
    ["/api/v1/auth/login", "POST"],
    ["/api/v1/auth/logout", "POST"],
    ["/api/v1/meters", "GET, HEAD"],
    ["/api/v1/meters/all", "GET, HEAD"],
    ["/api/v1/meters/export", "GET, HEAD"],
    ["/api/v1/meters/query", "GET, HEAD"],
    ["/api/v1/meters/nearby", "GET, HEAD"],
    ["/api/v1/meters/:meter_id", "GET, HEAD"],
    ["/api/v1/meters/:meter_id/overview", "GET, HEAD"],
    ["/api/v1/meters/:meter_id/location", "GET, HEAD"],
    ["/api/v1/meters/:meter_id/readings", "GET, HEAD"],
    ["/api/v1/transformers", "GET, HEAD"],
    ["/api/v1/transformers/:transformer_code/meters", "GET, HEAD"],
    ["/api/v1/transformers/:transformer_code/summary", "GET, HEAD"],
  ])
    app.all(path, (req, res, next) => {
      res.setHeader("Allow", allow);
      next(new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed."));
    });
  app.use((req, res, next) =>
    next(new ApiError(404, "NOT_FOUND", "Endpoint not found.")),
  );
  app.use((error, req, res, next) => {
    if (res.destroyed) return;
    if (res.headersSent) return next(error);
    if (error instanceof ApiError && error.retryAfter !== undefined)
      res.setHeader("Retry-After", String(error.retryAfter));
    if (error instanceof URIError && error.status === 400)
      error = new ApiError(
        400,
        "INVALID_REQUEST",
        "Invalid percent encoding in URL.",
      );
    if (error.type === "entity.parse.failed")
      error = new ApiError(
        400,
        "INVALID_REQUEST",
        "Request body must be JSON.",
      );
    if (error.type === "entity.too.large")
      error = new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request body exceeds 8 KiB.",
      );
    const known = error instanceof ApiError;
    if (!known)
      logger.error(
        { request_id: req.requestId, code: "INTERNAL_ERROR" },
        "Unexpected request failure",
      );
    res.status(known ? error.status : 500).json({
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "An unexpected error occurred.",
      },
      meta: { request_id: req.requestId },
    });
  });
  return app;
}
