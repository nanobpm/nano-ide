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
  assert.equal(records.length, 1);
  assert.equal(records[0].level, "info");
  assert.equal(records[0].msg, "hello");
  assert.deepEqual({ ...records[0].fields }, { a: 1 });
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
  assert.deepEqual({ ...records[0].fields }, { jobType: "charge", jobKey: "7" });
  assert.deepEqual({ ...records[1].fields }, { jobType: "charge", jobKey: "7", attempt: 2 });
});

test("per-call fields win over bound context on key clash", () => {
  const { records, sink } = recorder();
  createLogger(sink).child({ attempt: 1 }).info("x", { attempt: 9 });
  assert.deepEqual({ ...records[0].fields }, { attempt: 9 });
});

test("child() accumulates bindings down a chain and does not mutate the parent", () => {
  const { records, sink } = recorder();
  const base = createLogger(sink).child({ app: "demo" });
  const child = base.child({ jobKey: "1" });
  base.info("base");
  child.info("child");
  assert.deepEqual({ ...records[0].fields }, { app: "demo" });
  assert.deepEqual({ ...records[1].fields }, { app: "demo", jobKey: "1" });
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

test("formatLogRecord never throws when enumerating a field throws (getter/proxy trap)", () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  const rec = JSON.parse(formatLogRecord("warn", "boom", hostile, 8));
  assert.deepEqual(rec, { ts: 8, level: "warn", msg: "boom", fieldsError: "unserializable log fields" });
});

test("formatLogRecord writes an untrusted __proto__ field key as a plain own property", () => {
  // JSON.parse builds a genuine own "__proto__" property (unlike the `{ __proto__: … }` literal,
  // which sets the prototype) — the untrusted-key case the null-prototype record must survive.
  const fields: LogFields = JSON.parse('{"__proto__":{"polluted":true}}');
  const rec = JSON.parse(formatLogRecord("info", "hardened", fields, 3));
  assert.equal(rec.ts, 3);
  assert.equal(rec.msg, "hardened");
  assert.deepEqual(Object.getOwnPropertyDescriptor(rec, "__proto__")?.value, { polluted: true });
});

test("child() with an untrusted __proto__ binding key does not pollute Object.prototype", () => {
  const { records, sink } = recorder();
  const bindings: LogFields = JSON.parse('{"__proto__":{"polluted":true}}');
  createLogger(sink).child(bindings).info("x");
  const fields = records[0].fields ?? {};
  assert.deepEqual(Object.getOwnPropertyDescriptor(fields, "__proto__")?.value, { polluted: true });
});

test("an untrusted __proto__ per-call field with no bound context still merges into a null-proto bag", () => {
  // The no-bindings merge path must normalize too, so a custom sink that later spreads the bag can't
  // be tripped by the magic prototype setter. JSON.parse builds a genuine own "__proto__" key.
  const { records, sink } = recorder();
  const fields: LogFields = JSON.parse('{"__proto__":{"polluted":true}}');
  createLogger(sink).info("x", fields);
  const merged = records[0].fields;
  assert.ok(merged !== undefined);
  assert.equal(Object.getPrototypeOf(merged), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged, "__proto__")?.value, { polluted: true });
});

test("a log call never throws when a hostile fields object defeats the merge", () => {
  // A Proxy whose ownKeys trap throws breaks mergeFields before it can reach the sink; the emit guard
  // must degrade to a field-free error line rather than propagate into the caller.
  const { records, sink } = recorder();
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  assert.doesNotThrow(() => createLogger(sink).info("boom", hostile));
  assert.equal(records.length, 1);
  assert.equal(records[0].msg, "boom");
  assert.deepEqual({ ...records[0].fields }, { fieldsError: "unmergeable log fields" });
});

test("a log call never throws when the sink itself throws", () => {
  const throwingSink = () => {
    throw new Error("sink down");
  };
  assert.doesNotThrow(() => createLogger(throwingSink).info("x", { a: 1 }));
});

test("child() never throws when the added bindings are hostile — degrades to the parent context", () => {
  // A Proxy whose ownKeys trap throws would break the Object.assign merge in child(); like emit(),
  // child() must not propagate into the caller. It degrades to a child bound to just the parent
  // context, and that child still logs normally with its inherited bindings.
  const { records, sink } = recorder();
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  const parent = createLogger(sink).child({ orderId: "o1" });
  let child: ReturnType<typeof parent.child> | undefined;
  assert.doesNotThrow(() => {
    child = parent.child(hostile);
  });
  child?.info("shipped");
  assert.equal(records.length, 1);
  assert.equal(records[0].msg, "shipped");
  assert.deepEqual({ ...records[0].fields }, { orderId: "o1" });
});
