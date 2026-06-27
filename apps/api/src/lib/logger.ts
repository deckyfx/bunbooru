import { envConfig } from "../env-config";

/** Severity levels, ordered. */
type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured context attached to a log line. */
type LogFields = Record<string, unknown>;

/**
 * Emit one structured (JSON) log line — machine-readable for log aggregation.
 * Errors go to stderr, everything else to stdout.
 */
function emit(level: LogLevel, message: string, fields: LogFields): void {
  // Stay silent under the test runner so assertions read cleanly.
  if (Bun.env.NODE_ENV === "test") return;

  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Structured application logger. `debug` is suppressed outside development so
 * production logs stay signal-dense.
 */
export const logger = {
  debug(message: string, fields: LogFields = {}): void {
    if (envConfig.isDevelopment) emit("debug", message, fields);
  },
  info(message: string, fields: LogFields = {}): void {
    emit("info", message, fields);
  },
  warn(message: string, fields: LogFields = {}): void {
    emit("warn", message, fields);
  },
  error(message: string, fields: LogFields = {}): void {
    emit("error", message, fields);
  },
};
