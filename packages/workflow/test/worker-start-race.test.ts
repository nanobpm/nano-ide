// Red/green guard for #415: the `WorkflowClient` job-worker adapter must align
// with `@nanobpm/nano-sdk` >=1.2.5's SELF-STARTING worker lifecycle. On the
// Falcon/auto path `createJobWorker` returns a worker with a NULL transport,
// detects Nano asynchronously, then `bindTransport(t)` + `start()`s the worker
// ITSELF. The adapter's eager `start()` must therefore be null-safe:
//
//   * calling the underlying `start()` before the async bind resolves must NOT
//     crash — the old adapter did `void worker.start()`, leaving an UNHANDLED
//     REJECTION (`TypeError: Cannot read properties of null (reading
//     'subscribe')`) that took the process down; and
//   * the transport must be subscribed EXACTLY ONCE — by the SDK's own self-start
//     after bind, not by a duplicate eager start.
//
// This drives against `adaptJobWorker` (the extracted adapter seam) with a stub
// SDK worker whose transport binds asynchronously, so it needs no gateway.
import { test } from "node:test";
import assert from "node:assert/strict";

import { adaptJobWorker } from "../dist/client.js";

/** Models `@nanobpm/nano-sdk` 1.2.5's `NanoJobWorker` on the Falcon/auto path:
 *  constructed with a NULL transport, it binds asynchronously and SELF-STARTS,
 *  and its `start()` dereferences the transport with no null guard — so a
 *  pre-bind call rejects with a `TypeError` on the null transport, exactly like
 *  the real worker. */
class SelfStartingWorker {
  transport: { subscribe(): void } | null = null;
  subscribes = 0;
  stopped = false;

  constructor() {
    // Asynchronous Nano detection: bind the transport on a later microtask, then
    // start the worker OURSELVES (the self-start the adapter must not duplicate).
    queueMicrotask(() => {
      this.bindTransport({
        subscribe: () => {
          this.subscribes += 1;
        },
      });
      void this.start();
    });
  }

  bindTransport(t: { subscribe(): void }): void {
    this.transport = t;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // No null guard — mirrors nano-sdk 1.2.5, so a pre-bind call blows up here.
    this.transport.subscribe();
  }

  stop(): void {
    this.stopped = true;
  }

  async stopGracefully(): Promise<void> {
    this.stopped = true;
  }
}

/** A raw worker whose `start()` fails with an arbitrary, NON-race error (either
 *  synchronously or as a rejection). Models a genuine start failure on the
 *  REST/manual path or any other SDK error — the class of failure the adapter must
 *  NOT silently swallow. */
class FailingWorker {
  mode: "sync" | "async";
  constructor(mode: "sync" | "async") {
    this.mode = mode;
  }
  start(): void | Promise<void> {
    const err = new Error("boom: real start failure");
    if (this.mode === "sync") throw err;
    return Promise.reject(err);
  }
  stop(): void {}
  async stopGracefully(): Promise<void> {}
}

/** A raw worker whose `start()` fails with a NULL/undefined-dereference
 *  `TypeError` that is NOT the SDK's pre-bind transport race — it reads a
 *  DIFFERENT property (`config`), not `subscribe`. Models a genuine start bug
 *  that merely happens to be a null deref: the adapter must still surface it, not
 *  mistake it for the recoverable pre-bind `subscribe` race and swallow it. */
class NullDerefOnOtherPropWorker {
  mode: "sync" | "async";
  constructor(mode: "sync" | "async") {
    this.mode = mode;
  }
  start(): void | Promise<void> {
    // A real (non-race) null deref on an UNRELATED property.
    const err = new TypeError("Cannot read properties of null (reading 'config')");
    if (this.mode === "sync") throw err;
    return Promise.reject(err);
  }
  stop(): void {}
  async stopGracefully(): Promise<void> {}
}

for (const mode of ["sync", "async"] as const) {
  test(`adaptJobWorker.start() surfaces a non-race null-deref TypeError (reading a different property) instead of masking it as the pre-bind race — ${mode}`, async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const worker = adaptJobWorker(new NullDerefOnOtherPropWorker(mode));

      assert.doesNotThrow(() => worker.start());
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, [], "a real null-deref start failure must not become an unhandled rejection");

      // Only the SDK's known `subscribe` race is swallowed silently; a null deref
      // on ANY OTHER property is a genuine failure and must be surfaced.
      assert.equal(warnings.length, 1, "a non-`subscribe` null-deref start failure must be surfaced via console.warn");
      const flat = warnings[0].map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      assert.match(flat, /reading 'config'/, "the surfaced warning must carry the underlying error");
    } finally {
      console.warn = originalWarn;
      process.off("unhandledRejection", onRejection);
    }
  });
}

for (const mode of ["sync", "async"] as const) {
  test(`adaptJobWorker.start() surfaces a genuine (non-race) ${mode} start failure instead of masking it`, async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const worker = adaptJobWorker(new FailingWorker(mode));

      // A real failure must neither crash synchronously…
      assert.doesNotThrow(() => worker.start());
      // …nor escape as an unhandled rejection…
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, [], "a real start failure must not become an unhandled rejection");

      // …but it MUST be surfaced (not silently swallowed like the pre-bind race).
      assert.equal(warnings.length, 1, "a real start failure must be surfaced via console.warn");
      const flat = warnings[0].map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      assert.match(flat, /real start failure/, "the surfaced warning must carry the underlying error");
    } finally {
      console.warn = originalWarn;
      process.off("unhandledRejection", onRejection);
    }
  });
}

test("adaptJobWorker.start() is null-safe against nano-sdk's async self-start (no crash, subscribes exactly once)", async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const raw = new SelfStartingWorker();
    const worker = adaptJobWorker(raw);

    // Eager start BEFORE the async transport bind — must not throw synchronously…
    assert.doesNotThrow(() => worker.start());

    // …and must not leave an unhandled rejection when the pre-bind start rejects
    // on the null transport (let microtasks + a turn of the loop settle first).
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      rejections,
      [],
      "the pre-bind start race must be swallowed, not surface as an unhandled rejection",
    );

    // The SDK's own self-start (after bind) subscribed the transport exactly once;
    // the adapter's eager start neither crashed nor added a duplicate subscribe.
    assert.equal(raw.subscribes, 1, "the transport is subscribed exactly once, by the SDK self-start");

    // The pre-bind race is recovered by the SDK's self-start, so it must be
    // swallowed SILENTLY — not surfaced as a warning (that is reserved for real
    // start failures).
    assert.deepEqual(warnings, [], "the pre-bind transport race must be swallowed silently, not warned");
  } finally {
    console.warn = originalWarn;
    process.off("unhandledRejection", onRejection);
  }
});
