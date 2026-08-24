import { envConfig } from "../env-config";

/** Severity levels, ordered. */
type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured context attached to a log line. */
type LogFields = Record<string, unknown>;

/** ANSI SGR codes, applied only when the destination stream is a colour-capable TTY. */
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  grey: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
} as const;

/** Fixed-width label + colour per level, so the eye can scan a column. */
const LEVEL_STYLE: Record<LogLevel, { label: string; colour: string }> = {
  debug: { label: "DEBUG", colour: ANSI.grey },
  info: { label: "INFO ", colour: ANSI.cyan },
  warn: { label: "WARN ", colour: ANSI.yellow },
  error: { label: "ERROR", colour: ANSI.red },
};

/**
 * Column the field list starts at. Messages are event names (`plugin_loaded`),
 * so they cluster well under this; a longer one simply pushes its own fields
 * right rather than truncating — never lose information to make a column.
 */
const MESSAGE_WIDTH = 26;

/**
 * Whether to emit ANSI escapes to `stream`. A redirected stream (`> app.log`,
 * a pipe into `jq`, a CI runner) is not a TTY, so colour codes would land in
 * the file as noise. `NO_COLOR` is the cross-tool opt-out convention; the
 * `FORCE_COLOR` escape hatch covers terminals behind a pipe that still render.
 */
function supportsColour(stream: NodeJS.WriteStream): boolean {
  if (Bun.env.NO_COLOR) return false;
  if (Bun.env.FORCE_COLOR) return true;
  return stream.isTTY === true;
}

/** `HH:MM:SS.mmm` in local time — a developer reads a clock, not an ISO string. */
function shortTime(at: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/**
 * Render one field value. Scalars print bare so the common case stays terse;
 * anything with whitespace (or any non-scalar) is JSON-encoded so the `k=v`
 * pairing can never be misread when a value contains a space.
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"]/.test(value) || value === "" ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/** Human-readable single line: `12:30:04.512 INFO  plugin_loaded  id=example`. */
export function formatPretty(
  level: LogLevel,
  message: string,
  fields: LogFields,
  at: Date,
  colour: boolean,
): string {
  const { label, colour: levelColour } = LEVEL_STYLE[level];
  const paint = (text: string, code: string) => (colour ? `${code}${text}${ANSI.reset}` : text);

  // `Object.keys` does not invoke getters; reading each value does — so the read
  // is guarded per field. `Object.entries` would have invoked every getter up
  // front, and one that throws would take the whole log line (and the request)
  // with it. Guarding per field also keeps the OTHER fields readable, which is
  // the point of a diagnostic line.
  const rendered = Object.keys(fields)
    .map((key) => {
      let value: string;
      try {
        value = renderValue(fields[key]);
      } catch {
        value = "[unserializable]";
      }
      return `${paint(key, ANSI.dim)}=${value}`;
    })
    .join(" ");

  const head = `${paint(shortTime(at), ANSI.grey)} ${paint(label, levelColour)}`;
  // Pad only when fields follow — a bare message shouldn't carry trailing spaces.
  const body = rendered ? `${message.padEnd(MESSAGE_WIDTH)} ${rendered}` : message;
  return `${head} ${body}`;
}

/**
 * `JSON.stringify` replacer that survives values it would otherwise reject.
 *
 * Plain `stringify` THROWS on a `bigint` and on a cyclic structure — and a logger
 * that throws takes the request with it, turning a diagnostic into an outage. It
 * also flattens an `Error` to `{}`, silently discarding the one field anybody
 * logging an error wants.
 *
 * The shared `seen` set means a genuinely repeated (but acyclic) reference also
 * renders as `[circular]`. That is an accepted trade: a slightly lossy log line
 * beats a thrown one.
 */
function jsonSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  };
}

/** One machine-readable object per line, for log aggregation. */
export function formatJson(
  level: LogLevel,
  message: string,
  fields: LogFields,
  at: Date,
): string {
  // Fields spread FIRST so the reserved keys always win. A caller passing
  // `{ level: "info" }` on an error — or a `message` field echoing user input —
  // must not be able to rewrite the line's own metadata and mislead a log search.
  try {
    // Spread INSIDE the try: expanding `fields` invokes its own enumerable
    // getters, so a getter that throws would escape a try placed after this line.
    const line = { ...fields, level, time: at.toISOString(), message };
    return JSON.stringify(line, jsonSafeReplacer());
  } catch {
    // Last resort — a getter that throws, or anything the replacer can't tame.
    // Emit the metadata without the fields rather than lose the line entirely.
    return JSON.stringify({ level, time: at.toISOString(), message, fields: "[unserializable]" });
  }
}

/**
 * Emit one log line in the configured format ({@link EnvConfig.LOG_FORMAT}).
 * Errors go to stderr, everything else to stdout.
 */
function emit(level: LogLevel, message: string, fields: LogFields): void {
  // Stay silent under the test runner so assertions read cleanly.
  if (Bun.env.NODE_ENV === "test") return;

  const at = new Date();
  const stream = level === "error" ? process.stderr : process.stdout;
  const line =
    envConfig.LOG_FORMAT === "pretty"
      ? formatPretty(level, message, fields, at, supportsColour(stream))
      : formatJson(level, message, fields, at);

  // Write to the stream directly rather than via console.*: Bun's console.error
  // wraps stderr output in its own red SGR, which would nest inside (and reset)
  // the per-level colouring above and leave stray escapes mid-line.
  stream.write(`${line}\n`);
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
