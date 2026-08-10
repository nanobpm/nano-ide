// Structured logging for Urban apps. A worker handler and an API route delegate both receive an
// `AppApi` whose `log` is a {@link Logger}: an ergonomic, level-tagged sink that emits structured
// records (the host serializes them as NDJSON — one JSON object per line — to stdout/stderr).
//
// The value proposition over a bare `console.log`:
//   • Levels: `debug` / `info` / `warn` / `error`, each `(msg, fields?)`.
//   • Structured fields: pass a `{ … }` bag of context alongside the message rather than
//     string-concatenating; it lands as JSON keys a log processor can filter on.
//   • Bound context via `child(bindings)`: the runtime hands a worker handler a logger already
//     bound to `{ jobKey, jobType, processInstanceKey, elementId }`, and an operation delegate one
//     bound to `{ method, path, operationId }` — so every line a handler emits carries the
//     correlation context for free. Authors can bind more with their own `child()`.
//
// This module is pure (no `node:*`, no `Deno`, no `globalThis` output): it turns level+msg+fields
// into a call on an injected {@link LogSink}. The host adapter (node.ts / deno.ts) owns the sink —
// NDJSON encoding, the stdout/stderr split, and level filtering — so the same Logger works in every
// runtime and is trivially unit-testable with a fake sink. Kept `node:*`-free per the ADR 0052
// core-purity invariant (core/purity.test.ts).

/** Severity of a log record, from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A structured context bag attached to a log record. Values should be JSON-serializable. */
export type LogFields = Record<string, unknown>;

/**
 * The low-level output seam a {@link Logger} writes to. The host adapter supplies it and owns
 * encoding (NDJSON), stream routing (warn/error → stderr, else stdout) and level filtering. `fields`
 * is the merged bag (a logger's bound context overlaid with the per-call fields).
 */
export type LogSink = (level: LogLevel, msg: string, fields?: LogFields) => void;

/**
 * The logger surface injected as `AppApi.log`. Callable for back-compat (`log(level, msg, fields)`),
 * with per-level methods and `child()` for bound context. Prefer the methods:
 *
 *   app.log.info("charge captured", { amount, currency });
 *   const jobLog = app.log.child({ orderId });   // every line below carries orderId
 *   jobLog.warn("retrying", { attempt });
 */
export interface Logger {
  /** Back-compat callable form. Prefer `log.info(...)` etc. */
  (level: LogLevel, msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that merges `bindings` into every record it emits (per-call fields win on key clash). */
  child(bindings: LogFields): Logger;
}

/** Levels ordered by increasing severity; the index is the numeric threshold used for filtering. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(v: unknown): v is LogLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error";
}

/**
 * Parse a min-level string (e.g. from `URBAN_LOG_LEVEL`) into a {@link LogLevel}, case-insensitively,
 * falling back to `fallback` (default `"info"`) for an absent or unrecognized value.
 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const v = value?.trim().toLowerCase();
  return isLogLevel(v) ? v : fallback;
}

/** True when a record at `level` should be emitted given the configured `min` level. */
export function levelEnabled(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}

/** Merge bound context with per-call fields (per-call wins), omitting the `fields` key entirely when
 *  the result is empty so a context-free line stays `{ level, msg }` clean. Merges into a
 *  null-prototype object: log field keys are user-controlled, so an untrusted key like `__proto__`
 *  must set a plain own property rather than trip the magic prototype setter a normal `{}` inherits
 *  from `Object.prototype` (same treatment as untrusted-key dictionaries elsewhere in this repo). */
function mergeFields(bindings: LogFields, fields?: LogFields): LogFields | undefined {
  const boundKeys = Object.keys(bindings);
  if (boundKeys.length === 0) return fields;
  if (!fields || Object.keys(fields).length === 0) return Object.assign(Object.create(null), bindings);
  return Object.assign(Object.create(null), bindings, fields);
}

/** A single structured log record, as serialized to NDJSON. Reserved keys (`ts`, `level`, `msg`)
 *  lead; the flattened `fields` follow. A field named `ts`/`level`/`msg` cannot shadow a reserved
 *  key (the reserved value wins), so correlation on those keys stays reliable. */
export interface LogRecord {
  /** Epoch milliseconds when the line was emitted. */
  ts: number;
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

/**
 * Encode one structured log record as a single-line JSON string (no trailing newline). The reserved
 * `ts`/`level`/`msg` keys are written first and cannot be overwritten by a same-named field. Values
 * that don't survive `JSON.stringify` (a `bigint`, a circular object) are coerced so a bad field
 * never throws in the logging hot path or corrupts the stream. The whole build+encode path is
 * guarded (not just `JSON.stringify`), so a field whose enumeration itself throws (e.g. a getter or
 * Proxy trap) still yields a clean fallback line. The record is a null-prototype object so an
 * untrusted field key like `__proto__` sets a plain own property rather than tripping the magic
 * prototype setter.
 */
export function formatLogRecord(level: LogLevel, msg: string, fields: LogFields | undefined, now: number): string {
  try {
    const record: LogRecord = Object.create(null);
    record.ts = now;
    record.level = level;
    record.msg = msg;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (k === "ts" || k === "level" || k === "msg") continue;
        record[k] = v;
      }
    }
    return JSON.stringify(record, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  } catch {
    // A field that can't be built or serialized (circular ref, throwing getter) must not break logging.
    return JSON.stringify({ ts: now, level, msg, fieldsError: "unserializable log fields" });
  }
}

/** {@link formatLogRecord} plus a trailing newline — one NDJSON line for a raw stream write. */
export function formatLogLine(level: LogLevel, msg: string, fields: LogFields | undefined, now: number): string {
  return `${formatLogRecord(level, msg, fields, now)}\n`;
}

/**
 * Build a {@link Logger} over `sink`, optionally pre-bound to `bindings`. The returned value is a
 * callable object: it forwards `log(level, msg, fields)` to the sink and exposes `debug/info/warn/
 * error` plus `child()`. `bindings` is normalized into a null-prototype object (log field keys are
 * user-controlled, so an untrusted key like `__proto__` must not trip the magic prototype setter),
 * and `child(more)` returns a new logger whose bindings are `bindings` merged with `more` into a
 * fresh null-prototype object, so bound context accumulates safely down a call chain.
 */
export function createLogger(sink: LogSink, bindings: LogFields = {}): Logger {
  const bound: LogFields = Object.assign(Object.create(null), bindings);
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    sink(level, msg, mergeFields(bound, fields));
  };
  return Object.assign(emit, {
    debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
    info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
    warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
    error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
    child: (more: LogFields) => createLogger(sink, Object.assign(Object.create(null), bound, more)),
  });
}
