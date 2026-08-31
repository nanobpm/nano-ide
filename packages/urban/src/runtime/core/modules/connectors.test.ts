import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineClient, EngineJob, HostContext, JobHandler, WorkerSubscription } from "../host.ts";
import { BpmnError } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { defineWorker } from "../../connector-worker-sdk.ts";
import { adaptConnectorHandler, mountConnectors, resolveInstalledConnectors } from "./connectors.ts";
import { DataLayer } from "./datasource.ts";

/** A tiny engine that records registrations and can deliver a job to a handler. */
class MiniEngine implements EngineClient {
  workers = new Map<string, JobHandler>();
  async deployResources(): Promise<{ deployed: number }> { return { deployed: 0 }; }
  async createInstance(): Promise<{ processInstanceKey: string }> { return { processInstanceKey: "pi" }; }
  async cancelInstance(): Promise<void> {}
  async publishMessage(): Promise<void> {}
  async searchUserTasks(): Promise<[]> { return []; }
  async openUserTasks(): Promise<[]> { return []; }
  async getForm(): Promise<null> { return null; }
  async completeUserTask(): Promise<void> {}
  async searchProcessInstances(): Promise<[]> { return []; }
  async searchElementInstances(): Promise<[]> { return []; }
  async searchElementInstanceWaitStates(): Promise<[]> { return []; }
  async getElementInstance(): Promise<null> { return null; }
  async searchIncidents(): Promise<never[]> { return []; }
  async searchVariables(): Promise<never[]> { return []; }
  async searchJobs(): Promise<never[]> { return []; }
  async getProcessDefinitionXml(): Promise<null> { return null; }
  async resolveIncident(): Promise<void> {}
  async updateJobRetries(): Promise<void> {}
  async setVariables(): Promise<void> {}
  async registerWorker(jobType: string, handler: JobHandler): Promise<WorkerSubscription> {
    this.workers.set(jobType, handler);
    return { jobType, unsubscribe: async () => void this.workers.delete(jobType) };
  }
  deliver(jobType: string, job: EngineJob) {
    const h = this.workers.get(jobType);
    if (!h) throw new Error(`no worker for ${jobType}`);
    return h(job);
  }
  async close(): Promise<void> {}
}

interface FakeHostOptions {
  files?: Record<string, string>;
  env?: Record<string, string>;
  /** Called on importConnectorModule(entry): register the pack's workers. */
  onImport?: (entry: string) => void;
  /** Omit importConnectorModule entirely (host cannot host connectors). */
  noConnectorHost?: boolean;
}

function makeCtx(
  manifest: Partial<AppManifest>,
  engine: MiniEngine,
  opts: FakeHostOptions = {},
): { ctx: RuntimeContext; logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = [];
  const files = opts.files ?? {};
  const host: HostContext = {
    runtime: "node",
    env: (name) => opts.env?.[name],
    log: (level: string, msg: string) => logs.push({ level, msg }),
    exists: async (p: string) => p in files,
    readTextFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listDir: async () => [],
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: () => Promise.reject(new Error("no modules in this test")),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
  };
  if (!opts.noConnectorHost) {
    host.importConnectorModule = async (entry: string) => {
      opts.onImport?.(entry);
    };
  }
  const ctx: RuntimeContext = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", ...manifest },
    engine,
    host,
  };
  return { ctx, logs };
}

function makeApp(env: Record<string, string> = {}): AppApi {
  return {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data: new DataLayer(new Map(), undefined, {}),
    engine: new MiniEngine(),
    env: (n: string) => env[n],
    now: () => 0,
    wait: () => Promise.resolve(),
    log: createLogger(() => {}),
  };
}

const PKG = "@nanobpm/nano-ide-connector-slack";
const PACK_ID = "nano-ide-connector-slack";

function slackFiles(): Record<string, string> {
  return {
    "/app/package.json": JSON.stringify({ dependencies: { [PKG]: "^1.0.0" } }),
    [`/app/node_modules/${PKG}/nano-ide.ext.json`]: JSON.stringify({
      id: PACK_ID,
      workers: [
        {
          type: "slack:send-message",
          entry: "worker.ts",
          configFields: [{ key: "botToken", env: "SLACK_BOT_TOKEN" }],
        },
      ],
    }),
  };
}

test("resolveInstalledConnectors indexes packs by their manifest id", async () => {
  const { ctx } = makeCtx({}, new MiniEngine(), { files: slackFiles() });
  const packs = await resolveInstalledConnectors(ctx);
  assert.deepEqual([...packs.keys()], [PACK_ID]);
  assert.equal(packs.get(PACK_ID)?.dir, `node_modules/${PKG}`);
});

test("mountConnectors imports the pack entry and registers the drained worker", async () => {
  const engine = new MiniEngine();
  let importedEntry: string | undefined;
  const { ctx, logs } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: PACK_ID }] },
    engine,
    {
      files: slackFiles(),
      onImport: (entry) => {
        importedEntry = entry;
        defineWorker({
          type: "slack:send-message",
          async handle(job) {
            await job.complete({ echoed: job.variables.text });
          },
        });
      },
    },
  );
  const handle = await mountConnectors(ctx, makeApp({ SLACK_BOT_TOKEN: "xoxb-1" }));
  assert.deepEqual(handle.jobTypes, ["slack:send-message"]);
  assert.equal(importedEntry, `/app/node_modules/${PKG}/worker.ts`);
  assert.ok(logs.some((l) => l.msg === "connector worker registered"));

  const out = await engine.deliver("slack:send-message", {
    jobKey: "j1",
    jobType: "slack:send-message",
    processInstanceKey: "pi1",
    variables: { text: "hi" },
  });
  assert.deepEqual(out, { echoed: "hi" });
});

test("mountConnectors skips a worker whose required env is unset", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: PACK_ID }] },
    engine,
    { files: slackFiles(), onImport: () => assert.fail("must not import when env is missing") },
  );
  const handle = await mountConnectors(ctx, makeApp()); // no SLACK_BOT_TOKEN
  assert.deepEqual(handle.jobTypes, []);
  assert.ok(logs.some((l) => l.msg === "skipping connector worker: required env unset"));
});

test("mountConnectors fails closed when the connector pack is not installed", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: PACK_ID }] },
    engine,
    { files: { "/app/package.json": JSON.stringify({ dependencies: {} }) } },
  );
  await assert.rejects(
    () => mountConnectors(ctx, makeApp({ SLACK_BOT_TOKEN: "x" })),
    /not installed/,
  );
});

test("mountConnectors reports unsupported when the host cannot host connectors", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: PACK_ID }] },
    engine,
    { files: slackFiles(), noConnectorHost: true },
  );
  const handle = await mountConnectors(ctx, makeApp({ SLACK_BOT_TOKEN: "x" }));
  assert.deepEqual(handle.jobTypes, []);
  assert.ok(logs.some((l) => l.msg === "skipping connector worker: host cannot host connector packs"));
});

test("resolveInstalledConnectors surfaces a malformed app package.json", async () => {
  const { ctx } = makeCtx({}, new MiniEngine(), {
    files: { "/app/package.json": "{ not json" },
  });
  await assert.rejects(() => resolveInstalledConnectors(ctx), /failed to parse package\.json/);
});

test("mountConnectors fails closed on a duplicate worker type in one pack entry", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: PACK_ID }] },
    engine,
    {
      files: slackFiles(),
      onImport: () => {
        defineWorker({ type: "slack:send-message", async handle(job) { await job.complete({}); } });
        defineWorker({ type: "slack:send-message", async handle(job) { await job.complete({}); } });
      },
    },
  );
  await assert.rejects(
    () => mountConnectors(ctx, makeApp({ SLACK_BOT_TOKEN: "x" })),
    /more than once/,
  );
});

test("adaptConnectorHandler maps complete/fail/error(BpmnError) and a returned value", async () => {
  const job: EngineJob = { jobKey: "j", jobType: "t", processInstanceKey: "pi", variables: {} };

  const completes = adaptConnectorHandler({ type: "t", handle: async (j) => void (await j.complete({ a: 1 })) });
  assert.deepEqual(await completes(job), { a: 1 });

  const returns = adaptConnectorHandler({ type: "t", handle: async () => ({ b: 2 }) });
  assert.deepEqual(await returns(job), { b: 2 });

  const fails = adaptConnectorHandler({ type: "t", handle: async (j) => void (await j.fail("nope")) });
  await assert.rejects(() => Promise.resolve(fails(job)), /nope/);

  const errors = adaptConnectorHandler({ type: "t", handle: async (j) => void (await j.error("CODE", "boom")) });
  await assert.rejects(
    () => Promise.resolve(errors(job)),
    (e: unknown) => e instanceof BpmnError && e.errorCode === "CODE",
  );
});

test("adaptConnectorHandler fails loud on a job with no processInstanceKey (no masking to '')", async () => {
  // Guard for the decode-boundary defect class (Magikcraft/nano-bpm#940): a
  // keyless job must reject, never invoke the connector with a fabricated "".
  let handlerRan = false;
  const h = adaptConnectorHandler({
    type: "t",
    handle: async () => {
      handlerRan = true;
    },
  });
  const keyless: EngineJob = { jobKey: "j", jobType: "t", variables: {} };
  await assert.rejects(() => Promise.resolve(h(keyless)), /no processInstanceKey/);
  assert.equal(handlerRan, false, "connector handler must not run for a keyless job");

  // An empty-string key is the exact masking source and is rejected too.
  const emptyKey: EngineJob = { jobKey: "j", jobType: "t", processInstanceKey: "", variables: {} };
  await assert.rejects(() => Promise.resolve(h(emptyKey)), /no processInstanceKey/);
});
