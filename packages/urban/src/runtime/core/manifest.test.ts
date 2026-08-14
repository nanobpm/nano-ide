import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandEnvString,
  expandEnv,
  parseManifest,
  workerJobType,
  resolveBindMode,
  resolveBindHost,
  isBindMode,
  bindModeToHost,
  LOOPBACK_HOST,
  ALL_INTERFACES_HOST,
} from "./manifest.ts";

test("expandEnvString: var, default, and empty fallback", () => {
  const env: Record<string, string> = { FOO: "bar" };
  const look = (n: string) => env[n];
  assert.equal(expandEnvString("${FOO}", look), "bar");
  assert.equal(expandEnvString("${MISSING:-def}", look), "def");
  assert.equal(expandEnvString("${MISSING}", look), "");
  assert.equal(expandEnvString("x-${FOO}-${MISSING:-y}", look), "x-bar-y");
});

test("expandEnv recurses through objects and arrays", () => {
  const out = expandEnv(
    { a: "${X}", b: ["${Y:-2}", { c: "${X}" }], n: 5 },
    (n) => ({ X: "1" })[n],
  );
  assert.deepEqual(out, { a: "1", b: ["2", { c: "1" }], n: 5 });
});

test("parseManifest expands env in place", () => {
  const m = parseManifest('{"schemaVersion":1,"id":"x","name":"${NAME:-App}"}', () => undefined);
  assert.equal(m.name, "App");
});

test("workerJobType returns the taskType", () => {
  assert.equal(workerJobType({ taskType: "a", handler: "h" }), "a");
  assert.equal(workerJobType({ taskType: "llm-job", llm: "gpt" }), "llm-job");
});

test("bind mode defaults to loopback when the manifest omits network (issue #235)", () => {
  assert.equal(resolveBindMode({}), "loopback");
  assert.equal(resolveBindMode({ network: {} }), "loopback");
  assert.equal(resolveBindHost({}), LOOPBACK_HOST);
  assert.equal(resolveBindHost({}), "127.0.0.1");
});

test("manifest network.bind selects the interface", () => {
  assert.equal(resolveBindMode({ network: { bind: "all" } }), "all");
  assert.equal(resolveBindHost({ network: { bind: "all" } }), ALL_INTERFACES_HOST);
  assert.equal(resolveBindHost({ network: { bind: "all" } }), "0.0.0.0");
  assert.equal(resolveBindHost({ network: { bind: "loopback" } }), "127.0.0.1");
});

test("URBAN_BIND env overrides the manifest, invalid values are ignored", () => {
  const env = (v: string | undefined) => (n: string) => (n === "URBAN_BIND" ? v : undefined);
  // env override wins over the manifest in both directions
  assert.equal(resolveBindMode({ network: { bind: "loopback" } }, env("all")), "all");
  assert.equal(resolveBindMode({ network: { bind: "all" } }, env("loopback")), "loopback");
  assert.equal(resolveBindHost({ network: { bind: "loopback" } }, env("all")), "0.0.0.0");
  // an invalid or empty env value falls through to the manifest/default
  assert.equal(resolveBindMode({ network: { bind: "all" } }, env("bogus")), "all");
  assert.equal(resolveBindMode({}, env("")), "loopback");
});

test("isBindMode / bindModeToHost", () => {
  assert.equal(isBindMode("loopback"), true);
  assert.equal(isBindMode("all"), true);
  assert.equal(isBindMode("nope"), false);
  assert.equal(isBindMode(undefined), false);
  assert.equal(bindModeToHost("loopback"), "127.0.0.1");
  assert.equal(bindModeToHost("all"), "0.0.0.0");
});
