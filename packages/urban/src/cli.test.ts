import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdData } from "./cli.ts";
import { isRecord } from "./runtime/core/guards.ts";

// The `urban data` gateway's contract (see cmdData's docstring): *every* reply — including an
// unreadable request — is a parseable `{ ok: false, error }` envelope on stdout AND the process
// exits 0, so the Nano console can always parse the reply off stdout and never mistakes a
// malformed request for a subprocess crash. This guards the unreadable-request path, which used
// to exit non-zero and could make a caller that keys off the exit code discard the (parseable)
// error payload.
test("urban data exits 0 with a parseable envelope on an unreadable request", async () => {
  const flags: Parameters<typeof cmdData>[0] = {
    root: ".",
    manifest: "nano.app.json",
    check: false,
    deno: false,
    models: true,
    stdout: false,
    install: true,
    help: false,
    version: false,
    _: ["data"],
  };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let code: number;
  try {
    code = await cmdData(flags, async () => "this is not json {");
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  const reply: unknown = JSON.parse(lines[0]);
  assert.ok(isRecord(reply));
  assert.equal(reply.ok, false);
  if (typeof reply.error !== "string") throw new TypeError("expected string error");
  assert.match(reply.error, /^bad request: /);
});
