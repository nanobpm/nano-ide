import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLogger,
  formatLogLine,
  formatLogRecord,
  levelEnabled,
  LOG_LEVELS,
  parseLogLevel,
  type LogFields,
  type LogLevel,
} from "./logger.ts";

type Rec = { level: LogLevel; msg: string; fields?: LogFields };

function recorder() {
  const records: Rec[] = [];
  const sink = (level: LogLevel, msg: string, fields?: LogFields) => {
    records.push({ level, msg, fields });
  };
  return { records, sink };
}

test("per-level methods forward the level and message to the sink", () => {
  const { records, sink } = recorder();
  const log = createLogger(sink);
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.deepEqual(
    records.map((r) => [r.level, r.msg]),
    [
      ["debug", "d"],
      ["info", "i"],
      ["warn", "w"],
      ["error", "e"],
    ],
  );
});

test("the callable form still works for back-compat", () => {
  const { records, sink } = recorder();
  const log = createLogger(sink);
  log("info", "hello", { a: 1 });
  assert.deepEqual(records, [{ level: "info", msg: "hello", fields: { a: 1 } }]);
});

test("a context-free line carries no fields object", () => {
  const { records, sink } = recorder();
  createLogger(sink).info("plain");
  assert.deepEqual(records, [{ level: "info", msg: "plain", fields: undefined }]);
});

test("child() bindings are merged into every record", () => {
  const { records, sink } = recorder();
  const log = createLogger(sink).child({ jobType: "charge", jobKey: "7" });
  log.info("started");
  log.warn("retrying", { attempt: 2 });
  assert.deepEqual(records[0].fields, { jobType: "charge", jobKey: "7" });
  assert.deepEqual(records[1].fields, { jobType: "charge", jobKey: "7", attempt: 2 });
});

test("per-call fields win over bound context on key clash", () => {
  const { records, sink } = recorder();
  createLogger(sink).child({ attempt: 1 }).info("x", { attempt: 9 });
  assert.deepEqual(records[0].fields, { attempt: 9 });
});

test("child() accumulates bindings down a chain and does not mutate the parent", () => {
  const { records, sink } = recorder();
  const base = createLogger(sink).child({ app: "demo" });
  const child = base.child({ jobKey: "1" });
  base.info("base");
  child.info("child");
  assert.deepEqual(records[0].fields, { app: "demo" });
  assert.deepEqual(records[1].fields, { app: "demo", jobKey: "1" });
});

test("parseLogLevel is case-insensitive and falls back for unknown/absent input", () => {
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("  Warn "), "warn");
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel("verbose"), "info");
  assert.equal(parseLogLevel("verbose", "debug"), "debug");
});

test("levelEnabled gates records below the configured minimum", () => {
  assert.equal(levelEnabled("debug", "info"), false);
  assert.equal(levelEnabled("info", "info"), true);
  assert.equal(levelEnabled("error", "warn"), true);
  assert.equal(levelEnabled("warn", "error"), false);
});

test("LOG_LEVELS is ordered from most to least verbose", () => {
  assert.deepEqual([...LOG_LEVELS], ["debug", "info", "warn", "error"]);
});

test("formatLogRecord emits ts/level/msg plus flattened fields", () => {
  const rec = JSON.parse(formatLogRecord("info", "charged", { amount: 10, currency: "EUR" }, 1234));
  assert.deepEqual(rec, { ts: 1234, level: "info", msg: "charged", amount: 10, currency: "EUR" });
});

test("formatLogLine appends exactly one trailing newline", () => {
  const line = formatLogLine("warn", "x", undefined, 1);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), { ts: 1, level: "warn", msg: "x" });
});

test("formatLogRecord reserves ts/level/msg — a same-named field cannot shadow them", () => {
  const rec = JSON.parse(formatLogRecord("error", "real", { ts: 0, level: "info", msg: "fake", ok: true }, 999));
  assert.deepEqual(rec, { ts: 999, level: "error", msg: "real", ok: true });
});

test("formatLogRecord serializes a bigint field as its string form", () => {
  const rec = JSON.parse(formatLogRecord("info", "job", { jobKey: 9007199254740993n }, 5));
  assert.equal(rec.jobKey, "9007199254740993");
});

test("formatLogRecord never throws on an unserializable (circular) field", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const rec = JSON.parse(formatLogRecord("info", "loop", { circular }, 7));
  assert.deepEqual(rec, { ts: 7, level: "info", msg: "loop", fieldsError: "unserializable log fields" });
});
