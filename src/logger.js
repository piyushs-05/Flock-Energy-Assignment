import pino from "pino";

export function createLogger(level = "info", destination) {
  return pino(
    {
      level,
      redact: {
        paths: [
          "password",
          "email",
          "session_token",
          "headers",
          "req",
          "res",
          "err",
          "config",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
