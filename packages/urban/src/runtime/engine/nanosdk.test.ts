import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNanoSdkEngineClient,
  normalizeProcessInstanceState,
  requireProcessInstanceKey,
  SdkEngineClient,
  type NanoSdkActivatedJob,
  type NanoSdkClient,
  type NanoSdkJobWorker,
  type NanoSdkJobWorkerConfig,
} from "./nanosdk.ts";
import { BpmnError } from "../core/host.ts";

/** A fake nano-sdk client that records calls and lets a test drive its job worker. */
function fakeSdkClient(overrides: Partial<NanoSdkClient> = {}): NanoSdkClient & {
  calls: string[];
  deployments: File[][];
  workers: {
    cfg: NanoSdkJobWorkerConfig;
    started: number;
    stopped: number;
    dispatch: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  }[];
  closed: number;
} {
  const calls: string[] = [];
  const deployments: File[][] = [];
  const workers: {
    cfg: NanoSdkJobWorkerConfig;
    started: number;
    stopped: number;
    dispatch: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  }[] = [];
  let closed = 0;

  const client: NanoSdkClient & {
    calls: string[];
    deployments: File[][];
    workers: typeof workers;
    closed: number;
  } = {
    calls,
    deployments,
    workers,
    get closed() {
      return closed;
    },
    async createDeployment(input) {
      calls.push("createDeployment");
      deployments.push(input.resources);
      return { deployments: input.resources.map((_, i) => ({ i })) };
    },
    async createProcessInstance(input) {
      calls.push("createProcessInstance");
      return { processInstanceKey: 99, variables: input.variables };
    },
    async cancelProcessInstance(input) {
      calls.push("cancelProcessInstance");
      return { ...input };
    },
    async publishMessage(input) {
      calls.push("publishMessage");
      return { key: 1, ...input };
    },
    async searchUserTasks() {
      calls.push("searchUserTasks");
      return { items: [] };
    },
    async searchProcessInstances() {
      calls.push("searchProcessInstances");
      return { items: [] };
    },
    async completeUserTask() {
      calls.push("completeUserTask");
      return {};
    },
    async getFormByKey() {
      calls.push("getFormByKey");
      return {};
    },
    createJobWorker(cfg) {
      calls.push("createJobWorker");
      const rec = { cfg, started: 0, stopped: 0, dispatch: cfg.jobHandler };
      workers.push(rec);
      const worker: NanoSdkJobWorker = {
        start() {
          rec.started++;
        },
        stop() {
          rec.stopped++;
        },
      };
      // The real nano-sdk starts the worker itself after async transport detection
      // (autoStart defaults on). Model that here so the adapter must NOT call start().
      if (cfg.autoStart !== false) worker.start();
      return worker;
    },
    close() {
      closed++;
    },
    ...overrides,
  };
  return client;
}

test("requireProcessInstanceKey coerces and rejects empties", () => {
  assert.equal(requireProcessInstanceKey(42), "42");
  assert.equal(requireProcessInstanceKey("k"), "k");
  assert.throws(() => requireProcessInstanceKey(null), /missing processInstanceKey/);
  assert.throws(() => requireProcessInstanceKey(""), /missing processInstanceKey/);
});

test("deployResources builds web Files and calls createDeployment", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const res = await engine.deployResources([
    { name: "a.bpmn", content: "<x/>", contentType: "text/xml" },
    { name: "b.form", content: "{}", contentType: "application/json" },
  ]);
  assert.deepEqual(res, { deployed: 2 });
  assert.equal(client.deployments.length, 1);
  const [f0, f1] = client.deployments[0];
  assert.ok(f0 instanceof File);
  assert.equal(f0.name, "a.bpmn");
  assert.equal(f0.type, "text/xml");
  assert.equal(await f0.text(), "<x/>");
  assert.equal(f1.name, "b.form");
});

test("createInstance routes through the SDK and coerces the key", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const res = await engine.createInstance({ processDefinitionId: "p", variables: { a: 1 } });
  assert.equal(res.processInstanceKey, "99");
  assert.deepEqual(res.variables, { a: 1 });
  assert.ok(client.calls.includes("createProcessInstance"));
});

test("createInstance throws when the SDK response omits the instance key", async () => {
  const client = fakeSdkClient({
    createProcessInstance: async () => ({ variables: { ok: true } }),
  });
  const engine = new SdkEngineClient(client);
  await assert.rejects(
    () => engine.createInstance({ processDefinitionId: "p" }),
    /missing processInstanceKey/,
  );
});

test("cancelInstance routes through the SDK", async () => {
  let seen: { processInstanceKey: string | number } | undefined;
  const client = fakeSdkClient({
    cancelProcessInstance: async (input) => {
      seen = input;
      return {};
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.cancelInstance({ processInstanceKey: "pi-7" });
  assert.deepEqual(seen, { processInstanceKey: "pi-7" });
  assert.ok(client.calls.includes("cancelProcessInstance") || seen !== undefined);
});

test("publishMessage defaults correlationKey/variables", async () => {
  let seen: Record<string, unknown> | undefined;
  const client = fakeSdkClient({
    publishMessage: async (input) => {
      seen = input;
      return {};
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.publishMessage({ name: "m" });
  assert.deepEqual(seen, { name: "m", correlationKey: "", variables: {} });
});

test("searchUserTasks passes zero-wait consistency and maps items", async () => {
  let consistency: unknown;
  const client = fakeSdkClient({
    searchUserTasks: async (_input, c) => {
      consistency = c;
      return {
        items: [
          { userTaskKey: 7, elementId: "task_a", variables: { x: 1 } },
          { key: "" }, // keyless → skipped
          { userTaskKey: "8" },
        ],
      };
    },
  });
  const engine = new SdkEngineClient(client);
  const tasks = await engine.searchUserTasks({ processInstanceKey: "pi" });
  assert.deepEqual(consistency, { consistency: { waitUpToMs: 0 } });
  assert.deepEqual(tasks, [
    { userTaskKey: "7", elementId: "task_a", variables: { x: 1 } },
    { userTaskKey: "8", elementId: undefined, variables: undefined },
  ]);
});

test("searchUserTasks surfaces the resolved form linkage", async () => {
  const client = fakeSdkClient({
    searchUserTasks: async () => ({
      items: [
        { userTaskKey: 5, elementId: "approve", formKey: 42 },
        { userTaskKey: 6, elementId: "review", externalFormReference: "https://x/form" },
        { userTaskKey: 7, elementId: "plain", formKey: null, externalFormReference: null },
      ],
    }),
  });
  const engine = new SdkEngineClient(client);
  const tasks = await engine.searchUserTasks();
  assert.deepEqual(tasks, [
    { userTaskKey: "5", elementId: "approve", variables: undefined, formKey: "42" },
    { userTaskKey: "6", elementId: "review", variables: undefined, externalFormReference: "https://x/form" },
    { userTaskKey: "7", elementId: "plain", variables: undefined },
  ]);
});

test("getForm resolves by formKey and parses the serialized schema", async () => {
  let seen: unknown;
  const schema = { type: "default", schemaVersion: 18, components: [{ type: "textfield", key: "name" }] };
  const client = fakeSdkClient({
    getFormByKey: async (input, c) => {
      seen = { input, c };
      return { formKey: "42", formId: "myForm", version: 3, schema: JSON.stringify(schema) };
    },
  });
  const engine = new SdkEngineClient(client);
  const form = await engine.getForm({ formKey: "42" });
  assert.deepEqual(seen, { input: { formKey: "42" }, c: { consistency: { waitUpToMs: 0 } } });
  assert.deepEqual(form, { formKey: "42", formId: "myForm", version: 3, schema });
});

test("getForm falls back to formId as the key when no formKey is given", async () => {
  let seen: unknown;
  const client = fakeSdkClient({
    getFormByKey: async (input) => {
      seen = input;
      return { schema: JSON.stringify({ type: "default", components: [] }) };
    },
  });
  const engine = new SdkEngineClient(client);
  const form = await engine.getForm({ formId: "myForm" });
  assert.deepEqual(seen, { formKey: "myForm" });
  assert.deepEqual(form?.schema, { type: "default", components: [] });
});

test("getForm falls back to formId when formKey is empty/whitespace, not just absent", async () => {
  // Regression: `formKey ?? formId` treated an empty-string key as present and short-
  // circuited to null, ignoring a valid formId fallback (→ a spurious 204). An empty or
  // whitespace-only identifier must be resolved as *missing*.
  for (const formKey of ["", "   "]) {
    let seen: unknown;
    const client = fakeSdkClient({
      getFormByKey: async (input) => {
        seen = input;
        return { schema: JSON.stringify({ type: "default", components: [] }) };
      },
    });
    const engine = new SdkEngineClient(client);
    const form = await engine.getForm({ formKey, formId: "myForm" });
    assert.deepEqual(seen, { formKey: "myForm" }, `formKey=${JSON.stringify(formKey)} must fall through to formId`);
    assert.deepEqual(form?.schema, { type: "default", components: [] });
  }
});

test("getForm trims a padded identifier before the engine lookup", async () => {
  // Regression: the presence check trimmed only for the emptiness test but forwarded the
  // *untrimmed* value, so a padded `" 42 "` was fetched with the spaces and 404'd.
  let seen: unknown;
  const client = fakeSdkClient({
    getFormByKey: async (input) => {
      seen = input;
      return { schema: JSON.stringify({ type: "default", components: [] }) };
    },
  });
  const engine = new SdkEngineClient(client);
  const form = await engine.getForm({ formKey: "  42  " });
  assert.deepEqual(seen, { formKey: "42" }, "the padded formKey is trimmed before lookup");
  assert.deepEqual(form?.schema, { type: "default", components: [] });
});

test("getForm returns null when no identifier is given or the fetch fails", async () => {
  const throwing = fakeSdkClient({
    getFormByKey: async () => {
      throw new Error("404 not found");
    },
  });
  const engine = new SdkEngineClient(throwing);
  assert.equal(await engine.getForm({}), null);
  assert.equal(await engine.getForm({ formKey: "missing" }), null);
});

test("getForm returns null when the schema is not valid JSON", async () => {
  const client = fakeSdkClient({
    getFormByKey: async () => ({ formKey: "42", schema: "not json" }),
  });
  const engine = new SdkEngineClient(client);
  assert.equal(await engine.getForm({ formKey: "42" }), null);
});

test("getForm's invalid-JSON warning records the formId when only formId is given", async () => {
  const logs: { level: string; message: string; details?: unknown }[] = [];
  const client = fakeSdkClient({
    getFormByKey: async () => ({ formKey: "42", schema: "not json" }),
  });
  const engine = new SdkEngineClient(client, (level, message, details) => {
    logs.push({ level, message, details });
  });
  assert.equal(await engine.getForm({ formId: "myForm" }), null);
  const warn = logs.find((l) => l.message === "getForm: form schema is not valid JSON");
  assert.ok(warn, "invalid-JSON schema is warned");
  // A formId-only caller must not be logged as { formKey: undefined } — the
  // resolved identifier that was actually used (`key`) has to be traceable.
  assert.deepEqual(warn.details, { key: "myForm", formKey: undefined, formId: "myForm" });
});

test("completeUserTask routes through the SDK", async () => {
  let seen: unknown;
  const client = fakeSdkClient({
    completeUserTask: async (input) => {
      seen = input;
      return {};
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.completeUserTask("utk", { done: true });
  assert.deepEqual(seen, { userTaskKey: "utk", variables: { done: true } });
});

test("searchProcessInstances filters by keys ($in) + state with a matching page cap", async () => {
  let seenInput: unknown;
  let seenConsistency: unknown;
  const client = fakeSdkClient({
    searchProcessInstances: async (input, c) => {
      seenInput = input;
      seenConsistency = c;
      return {
        items: [
          { processInstanceKey: 7, state: "TERMINATED" },
          { processInstanceKey: "8", state: "ACTIVE" },
        ],
      };
    },
  });
  const engine = new SdkEngineClient(client);
  const out = await engine.searchProcessInstances({
    processInstanceKeys: ["7", "8", ""], // empty key dropped from the $in
    state: "TERMINATED",
  });
  assert.deepEqual(seenInput, {
    filter: { state: "TERMINATED", processInstanceKey: { $in: ["7", "8"] } },
    page: { limit: 2 },
  });
  assert.deepEqual(seenConsistency, { consistency: { waitUpToMs: 0 } });
  assert.deepEqual(out, [
    { processInstanceKey: "7", state: "TERMINATED" },
    { processInstanceKey: "8", state: "ACTIVE" },
  ]);
});

test("searchProcessInstances with no keys sends no key filter and no page cap", async () => {
  let seenInput: unknown;
  const client = fakeSdkClient({
    searchProcessInstances: async (input) => {
      seenInput = input;
      return { items: [] };
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.searchProcessInstances();
  assert.deepEqual(seenInput, { filter: {} });
});

test("searchProcessInstances skips keyless and unrecognized-state rows", async () => {
  const client = fakeSdkClient({
    searchProcessInstances: async () => ({
      items: [
        { processInstanceKey: "", state: "TERMINATED" }, // keyless → skipped
        { processInstanceKey: 9, state: "SUSPENDED" }, // unknown state → skipped
        { processInstanceKey: 10, state: "completed" }, // case-insensitive → mapped
      ],
    }),
  });
  const engine = new SdkEngineClient(client);
  const out = await engine.searchProcessInstances();
  assert.deepEqual(out, [{ processInstanceKey: "10", state: "COMPLETED" }]);
});

test("normalizeProcessInstanceState maps the terminal set and rejects others", () => {
  assert.equal(normalizeProcessInstanceState("ACTIVE"), "ACTIVE");
  assert.equal(normalizeProcessInstanceState("completed"), "COMPLETED");
  assert.equal(normalizeProcessInstanceState("Terminated"), "TERMINATED");
  assert.equal(normalizeProcessInstanceState("SUSPENDED"), undefined);
  assert.equal(normalizeProcessInstanceState(42), undefined);
  assert.equal(normalizeProcessInstanceState(undefined), undefined);
});

test("registerWorker creates a worker the SDK auto-starts, and dispatches + completes", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const handled: Record<string, unknown>[] = [];
  const sub = await engine.registerWorker(
    "svc",
    (job) => {
      handled.push(job.variables);
      return { out: job.variables.n };
    },
    { maxParallelJobs: 4 },
  );
  assert.equal(sub.jobType, "svc");
  const rec = client.workers[0];
  // The adapter must not force autoStart off or call start() itself (that races the
  // SDK's async transport detection); the SDK owns the start lifecycle.
  assert.equal(rec.cfg.autoStart, undefined);
  assert.equal(rec.cfg.workerName, "urban:svc");
  assert.equal(rec.cfg.maxParallelJobs, 4);
  assert.equal(rec.started, 1);

  let completedWith: Record<string, unknown> | undefined;
  const job: NanoSdkActivatedJob = {
    jobKey: 12,
    processInstanceKey: 34,
    elementId: "e1",
    variables: { n: 5 },
    async complete(v?: Record<string, unknown>) {
      completedWith = v;
      return "receipt";
    },
    async fail() {
      throw new Error("should not fail");
    },
  };
  await rec.dispatch(job);
  assert.deepEqual(handled, [{ n: 5 }]);
  assert.deepEqual(completedWith, { out: 5 });

  await sub.unsubscribe();
  assert.equal(rec.stopped, 1);
});

test("registerWorker fails the job when the handler throws", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("svc", () => {
    throw new Error("boom");
  });
  const rec = client.workers[0];
  let failBody: { errorMessage: string; retries?: number } | undefined;
  const job: NanoSdkActivatedJob = {
    jobKey: "j1",
    variables: {},
    async complete() {
      throw new Error("should not complete");
    },
    async fail(body: { errorMessage: string; retries?: number }) {
      failBody = body;
      return "failed";
    },
  };
  await rec.dispatch(job);
  assert.equal(failBody?.errorMessage, "boom");
  // No retry count is pinned: the SDK decrements the job's remaining retries
  // (`job.retries - 1`), so a transient handler failure self-heals on redelivery and
  // only parks as an incident once the budget is exhausted.
  assert.equal(failBody?.retries, undefined);
  assert.equal("retries" in (failBody ?? {}), false);
});

test("registerWorker leaves a job for redelivery when complete() fails (transport error, not a handler bug)", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  let handlerRan = false;
  await engine.registerWorker("svc", () => {
    handlerRan = true;
    return { ok: true };
  });
  const rec = client.workers[0];
  let failCalled = false;
  const job: NanoSdkActivatedJob = {
    jobKey: "j1",
    variables: {},
    // The handler succeeded, but reporting the result to the engine fails transiently.
    async complete() {
      throw new Error("FOREIGN KEY constraint failed");
    },
    async fail() {
      failCalled = true;
      throw new Error("must not hard-park a job whose handler succeeded");
    },
  };
  // Must not throw, and must NOT call fail(retries:0) — the job is left locked for the
  // engine to redeliver on lock timeout.
  const result = await rec.dispatch(job);
  assert.equal(handlerRan, true);
  assert.equal(failCalled, false);
  assert.equal(result, undefined);
});

test("registerWorker routes a thrown BpmnError to the engine's error()", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("svc", () => {
    throw new BpmnError("NOT_FOUND", "no such record");
  });
  const rec = client.workers[0];
  let errorBody: { errorCode: string; errorMessage?: string } | undefined;
  const job: NanoSdkActivatedJob = {
    jobKey: "j1",
    variables: {},
    async complete() {
      throw new Error("should not complete");
    },
    async fail() {
      throw new Error("should not fail — a BPMN error is not a job failure");
    },
    async error(body: { errorCode: string; errorMessage?: string }) {
      errorBody = body;
      return "raised";
    },
  };
  await rec.dispatch(job);
  assert.equal(errorBody?.errorCode, "NOT_FOUND");
  assert.equal(errorBody?.errorMessage, "no such record");
});

test("registerWorker falls back to fail() for a BpmnError when the SDK has no error()", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("svc", () => {
    throw new BpmnError("NOT_FOUND", "no such record");
  });
  const rec = client.workers[0];
  let failBody: { errorMessage: string; retries?: number } | undefined;
  const job: NanoSdkActivatedJob = {
    jobKey: "j1",
    variables: {},
    async complete() {
      throw new Error("should not complete");
    },
    async fail(body: { errorMessage: string; retries?: number }) {
      failBody = body;
      return "failed";
    },
    // no error() — older transport
  };
  await rec.dispatch(job);
  assert.equal(failBody?.errorMessage, "no such record");
  // A BpmnError is a modelled, deterministic outcome: pin retries:0 so it does NOT consume the
  // retry budget (unlike a generic handler failure, which omits retries to self-heal).
  assert.equal(failBody?.retries, 0);
});

test("registerWorker falls back to fail() when the BPMN error report itself throws", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("svc", () => {
    throw new BpmnError("NOT_FOUND", "no such record");
  });
  const rec = client.workers[0];
  let failBody: { errorMessage: string; retries?: number } | undefined;
  const job: NanoSdkActivatedJob = {
    jobKey: "j1",
    variables: {},
    async complete() {
      throw new Error("should not complete");
    },
    async error() {
      throw new Error("transport down");
    },
    async fail(body: { errorMessage: string; retries?: number }) {
      failBody = body;
      return "failed";
    },
  };
  await rec.dispatch(job);
  // The job must still be acknowledged via fail() rather than silently dropped.
  assert.equal(failBody?.errorMessage, "no such record");
  // A BpmnError is a modelled, deterministic outcome: pin retries:0 so it does NOT consume the
  // retry budget (unlike a generic handler failure, which omits retries to self-heal).
  assert.equal(failBody?.retries, 0);
});

test("close stops every worker and closes the SDK client", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("a", async () => ({}));
  await engine.registerWorker("b", async () => ({}));
  await engine.close();
  assert.equal(client.workers[0].stopped, 1);
  assert.equal(client.workers[1].stopped, 1);
  assert.equal(client.closed, 1);
});

test("close drains the REST-fallback worker via the SDK's stopAllWorkers", async () => {
  let stopAllCalls = 0;
  const client = fakeSdkClient({
    async stopAllWorkers() {
      stopAllCalls++;
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("a", async () => ({}));
  await engine.close();
  // The SDK may start a REST-fallback worker whose handle we never receive;
  // close() must reach it through the client's stopAllWorkers().
  assert.equal(stopAllCalls, 1, "close awaits client.stopAllWorkers exactly once");
  assert.equal(client.closed, 1);
});

test("close tolerates a client without stopAllWorkers", async () => {
  const client = fakeSdkClient();
  delete client.stopAllWorkers;
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("a", async () => ({}));
  await engine.close();
  assert.equal(client.closed, 1);
});

test("exposes the underlying nano-sdk client as .sdk", () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  assert.equal(engine.sdk, client, "sdk returns the exact client the adapter was built from");
});

test("createNanoSdkEngineClient uses an injected client", async () => {
  const client = fakeSdkClient();
  const engine = await createNanoSdkEngineClient({ restAddress: "http://x/v2", client });
  await engine.createInstance({ processDefinitionId: "p" });
  assert.ok(client.calls.includes("createProcessInstance"));
});

test("createNanoSdkEngineClient uses an injected client factory with the resolved transport", async () => {
  let seen: { restAddress: string; token?: string; transport?: string } | undefined;
  const client = fakeSdkClient();
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    token: "t",
    transport: "falcon",
    createClient: (o) => {
      seen = o;
      return client;
    },
  });
  assert.deepEqual(seen, { restAddress: "http://x/v2", token: "t", transport: "falcon" });
  assert.ok(engine);
});
