import { z } from "zod";

const schema = z.object({
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PORTAL_ORIGIN: z
    .url()
    .default("https://urja-ops.flockenergy.tech")
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }, "Must be an HTTPS origin without credentials or a path"),
  PORTAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(10000),
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120000)
    .default(30000),
  PORTAL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  PORTAL_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(20),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  /** True on Render (and similar) so Express trusts X-Forwarded-* for rate limits. */
  TRUST_PROXY: z.boolean().default(false),
});

/** Local stays on loopback; Render sets RENDER and PORT — bind all interfaces there. */
export function defaultHost(env = process.env) {
  if (env.HOST) return env.HOST;
  return env.RENDER ? "0.0.0.0" : "127.0.0.1";
}

export function readConfig(env = process.env) {
  const parsed = schema.safeParse({
    ...env,
    HOST: defaultHost(env),
    TRUST_PROXY:
      env.TRUST_PROXY !== undefined
        ? ["1", "true", "yes"].includes(String(env.TRUST_PROXY).toLowerCase())
        : Boolean(env.RENDER),
  });
  if (!parsed.success)
    throw new Error(
      `Invalid configuration fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return parsed.data;
}
