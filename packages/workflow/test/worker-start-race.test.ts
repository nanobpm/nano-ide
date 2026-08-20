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

test("adaptJobWorker.start() is null-safe against nano-sdk's async self-start (no crash, subscribes exactly once)", async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
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
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
