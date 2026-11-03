import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defineWorker,
  drainDefinedWorkers,
  type ConnectorWorkerJob,
} from "./connector-worker-sdk.ts";

test("defineWorker records handlers that drainDefinedWorkers returns then clears", () => {
  drainDefinedWorkers(); // start clean
  defineWorker({ type: "a:one", maxParallelJobs: 3, handle: async () => ({}) });
  defineWorker({ type: "a:two", handle: async () => {} });
  const first = drainDefinedWorkers();
  assert.deepEqual(
    first.map((w) => w.type),
    ["a:one", "a:two"],
  );
  assert.equal(first[0].maxParallelJobs, 3);
  // Draining empties the registry: a second drain sees nothing.
  assert.deepEqual(drainDefinedWorkers(), []);
});

test("defineWorker carries the declared job lock timeout (timeoutMs) through the drain (issue #596)", () => {
  drainDefinedWorkers(); // start clean
  defineWorker({ type: "a:slow", timeoutMs: 900_000, handle: async () => ({}) });
  defineWorker({ type: "a:fast", handle: async () => ({}) });
  const [slow, fast] = drainDefinedWorkers();
  assert.equal(slow.timeoutMs, 900_000);
  assert.equal(fast.timeoutMs, undefined);
});

test("defineWorker rejects a missing type or non-function handle", () => {
  assert.throws(() => defineWorker({ type: "", handle: async () => ({}) }), /type` is required/);
  const missingHandle: Parameters<typeof defineWorker>[0] = JSON.parse('{"type":"x"}');
  assert.throws(
    () => defineWorker(missingHandle),
    /handle must be a function/,
  );
  // A failed defineWorker must not leave a partial registration behind.
  assert.deepEqual(drainDefinedWorkers(), []);
});

test("a registered handle receives the job facade and can complete", async () => {
  drainDefinedWorkers();
  let seen: ConnectorWorkerJob | undefined;
  defineWorker({
    type: "a:three",
    async handle(job) {
      seen = job;
      await job.complete({ ok: true });
    },
  });
  const [w] = drainDefinedWorkers();
  const completed: Record<string, unknown>[] = [];
  await w.handle({
    jobKey: "j1",
    type: "a:three",
    processInstanceKey: "p1",
    variables: { n: 1 },
    complete: async (v) => void completed.push(v ?? {}),
    fail: async () => {},
    error: async () => {},
  });
  assert.equal(seen?.jobKey, "j1");
  assert.deepEqual(completed, [{ ok: true }]);
});
