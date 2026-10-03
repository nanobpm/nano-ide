// Regression guard for the `Gateway.launch` partial-launch leak class (the sibling of the
// `start()`-path cleanup the round fixed): `launch()` must not leave its just-created scratch
// dir behind when a step *before* `start()` fails.
//
// The concrete defect: `mkdirSync(dataDir)` ran *before* `await freePort()`, and `freePort()`
// can reject (its `createServer` 'error' event — EADDRINUSE/EMFILE under fd pressure). That
// rejection escaped `launch()` before the try/catch around `gw.start()`, so the scratch dir was
// leaked even though no gateway process ever started. The fix acquires the port *before* creating
// the dir, so that failure path has nothing to clean up.
//
// This is a live-gateway test helper: the leak path is only reachable with a real gateway binary
// and an actual fd/port failure, neither of which exists in unit CI. So instead of driving a real
// launch, this pins the *ordering invariant* the fix establishes — the port is acquired before the
// scratch dir is created — directly against the `launch()` source. That is the structural property
// that removes the class, and it regresses loudly if someone reorders the steps back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(HERE, "server.ts"), "utf8");

// Slice out the `static async launch(...)` body so the ordering assertion is scoped to the
// method under test, not some other `freePort`/`mkdirSync` in the file.
function launchBody(): string {
  const start = SERVER_SRC.indexOf("static async launch(");
  assert.notEqual(start, -1, "Gateway.launch must exist");
  const end = SERVER_SRC.indexOf("async start():", start);
  assert.notEqual(end, -1, "launch body must be followed by start()");
  return SERVER_SRC.slice(start, end);
}

test("launch acquires the free port before creating the scratch dir (no pre-start dir leak)", () => {
  const body = launchBody();
  const portAt = body.indexOf("await freePort()");
  const mkdirAt = body.indexOf("mkdirSync(dataDir");
  assert.notEqual(portAt, -1, "launch must acquire a free port");
  assert.notEqual(mkdirAt, -1, "launch must create the scratch data dir");
  assert.ok(
    portAt < mkdirAt,
    "freePort() must run before mkdirSync(dataDir): a freePort() rejection escapes launch() " +
      "before the start() try/catch, so a dir created first would leak on that path",
  );
});
