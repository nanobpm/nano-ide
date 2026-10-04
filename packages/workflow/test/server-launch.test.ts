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

// Slice out the `async start(...)` body for the child-error rejection invariant below.
function startBody(): string {
  const start = SERVER_SRC.indexOf("async start():");
  assert.notEqual(start, -1, "Gateway.start must exist");
  const end = SERVER_SRC.indexOf("/** SIGKILL", start);
  assert.notEqual(end, -1, "start body must be followed by kill()");
  return SERVER_SRC.slice(start, end);
}

// The other half of the partial-launch leak class: a spawn/early-exec failure (a non-executable
// SERVER_BIN, spawn-time EMFILE) is reported by Node as an 'error' event on the child, NOT via
// the spawn() call. If start() only awaits topology readiness, that event is unhandled — it kills
// the test process and never reaches launch()'s try/catch, so the process/dir cleanup is skipped.
// Pin that start() rejects on the child's 'error' event (raced against readiness) so the failure
// becomes a rejected promise the launch() cleanup can handle.
test("start rejects on the child process 'error' event (startup failure reaches launch cleanup)", () => {
  const body = startBody();
  assert.ok(
    body.includes(`once("error"`) || body.includes("once('error'"),
    "start() must subscribe to the child's 'error' event so a spawn/exec failure rejects instead " +
      "of crashing the test process as an unhandled 'error' event",
  );
  assert.ok(
    body.includes("Promise.race("),
    "start() must race the child 'error' rejection against topology readiness so a startup " +
      "failure rejects start() (running the launch() cleanup) rather than hanging until timeout",
  );
  assert.ok(
    body.includes(`off("error"`) || body.includes("off('error'"),
    "start() must remove the 'error' listener once settled so a long-lived gateway does not " +
      "accumulate one listener per restart",
  );
});

// The third facet of the same leak class: when the child-'error' branch wins the start() race,
// waitForTopology() must not keep polling (fetch + sleep) until its 20s deadline — that dangling
// background task can keep the test process alive long after start() has already rejected. Pin
// that start() drives topology polling through an AbortController it aborts once the race settles,
// and that waitForTopology honours that signal (so the poll loop stops promptly on a lost race).
test("start aborts topology polling when the race settles (no dangling poll after a lost race)", () => {
  const body = startBody();
  assert.ok(
    body.includes("new AbortController("),
    "start() must create an AbortController to drive topology polling so it can be cancelled",
  );
  assert.ok(
    /\.abort\(\)/.test(body),
    "start() must abort the topology poll once the race settles so a lost topology race leaves " +
      "no background fetch/sleep loop running until the 20s deadline",
  );
  const src = SERVER_SRC.slice(SERVER_SRC.indexOf("private async waitForTopology("));
  const waitBody = src.slice(0, src.indexOf("\n  }") + 4);
  assert.ok(
    waitBody.includes("signal.aborted") && waitBody.includes("signal }"),
    "waitForTopology() must honour the abort signal (check signal.aborted and pass it to fetch) " +
      "so aborting it actually stops the poll loop",
  );
});
