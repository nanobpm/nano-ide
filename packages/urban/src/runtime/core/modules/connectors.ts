// connectors — mount connector-pack workers (ADR 0050, in-process port).
//
// A connector is an installed npm pack that ships a `nano-ide.ext.json` manifest
// and a worker `entry` program. The app enables it by adding a `workers[]` entry
// with a `connector: <pack-id>` field (no `handler`/`llm`) — see `urban add` and
// `addConnector`. This module resolves each such enabled worker to its installed
// pack, imports the pack `entry` in-process (via the host's `@nanobpm/worker`
// alias), and registers the drained handler on the engine like any other worker.
//
// The old Rust host supervised each connector worker as its own child process
// (ADR 0050 §4). The @nanobpm/urban runtime hosts app workers in-process, so it
// hosts connector workers the same way — trading process isolation for a simpler,
// single-process model. `job.error(code)` still routes to a real BPMN error.
//
// This file is runtime-agnostic (core purity): the Node/Deno specifics of aliasing
// the pack's `@nanobpm/worker` import live behind `host.importConnectorModule`.

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import { errorMessage, isRecord } from "../guards.ts";
import { BpmnError, type EngineJob, type JobHandler, type WorkerSubscription } from "../host.ts";
import { workerJobType, type Worker } from "../manifest.ts";
import {
  drainDefinedWorkers,
  type ConnectorWorkerJob,
  type DefinedConnectorWorker,
} from "../../connector-worker-sdk.ts";
import { runInJobContext } from "../execContext.ts";

/** A config field a pack declares (subset of ext-types `ConfigField`): an env
 *  pointer with an optional default. */
interface PackConfigField {
  key: string;
  env?: string;
  default?: string;
}

/** A worker a pack declares (subset of ext-types `WorkerSpec`). */
interface PackWorkerSpec {
  type: string;
  entry: string;
  maxParallelJobs?: number;
  configFields?: PackConfigField[];
}

/** The pack manifest (`nano-ide.ext.json`) fields the runtime reads. */
interface PackManifest {
  id: string;
  workers?: PackWorkerSpec[];
}

/** An installed connector pack, indexed by its manifest `id`. */
interface InstalledPack {
  id: string;
  /** Pack dir relative to the app root, e.g. `node_modules/@nanobpm/nano-ide-connector-slack`. */
  dir: string;
  manifest: PackManifest;
}

export interface ConnectorsHandle extends Mounted {
  readonly jobTypes: string[];
}

function joinRoot(root: string, p: string): string {
  return p.startsWith("/") ? p : `${root.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}

/** Env vars a pack worker requires before it can be imported/run: every config
 *  field that points at an env var and has no baked default. In-process, a missing
 *  var would let the pack's top-level guard `process.exit` the whole app, so the
 *  runtime skips the worker instead. */
function requiredEnv(spec: PackWorkerSpec): string[] {
  const seen = new Set<string>();
  for (const f of spec.configFields ?? []) {
    if (f.env && (f.default === undefined || f.default === "")) seen.add(f.env);
  }
  return [...seen];
}

/** Read + parse a JSON file under the app root; undefined if absent. In `strict`
 *  mode a malformed file throws a named parse error (used for the app's own files);
 *  otherwise a malformed file is treated as absent (used for third-party packs). */
async function readJson<T>(
  ctx: RuntimeContext,
  relPath: string,
  opts?: { strict?: boolean },
): Promise<T | undefined> {
  const path = joinRoot(ctx.root, relPath);
  if (!(await ctx.host.exists(path))) return undefined;
  try {
    const parsed: T = JSON.parse(await ctx.host.readTextFile(path));
    return parsed;
  } catch (err) {
    if (opts?.strict) {
      throw new Error(`failed to parse ${relPath}: ${errorMessage(err)}`);
    }
    return undefined;
  }
}

/**
 * Discover installed connector packs: read the app `package.json` dependencies,
 * and for each that ships a `nano-ide.ext.json` with a worker, index it by its
 * declared pack `id` (the value a manifest `worker.connector` field carries — NOT
 * the npm package name).
 */
export async function resolveInstalledConnectors(
  ctx: RuntimeContext,
): Promise<Map<string, InstalledPack>> {
  const out = new Map<string, InstalledPack>();
  const pkg = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>(ctx, "package.json", { strict: true });
  if (!pkg) return out;
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  for (const name of names) {
    const dir = `node_modules/${name}`;
    const manifest = await readJson<PackManifest>(ctx, `${dir}/nano-ide.ext.json`);
    if (!manifest || typeof manifest.id !== "string" || !manifest.id) continue;
    if (!Array.isArray(manifest.workers) || manifest.workers.length === 0) continue;
    out.set(manifest.id, { id: manifest.id, dir, manifest });
  }
  return out;
}

/** Wrap a pack's `DefinedConnectorWorker.handle` as an engine `JobHandler`,
 *  bridging the `@nanobpm/worker` job facade (complete/fail/error) to the engine
 *  seam. `job.error(code)` becomes a thrown {@link BpmnError} (routed to a BPMN
 *  error boundary by the engine adapter); `job.fail(msg)` a plain throw (retry). */
export function adaptConnectorHandler(worker: DefinedConnectorWorker): JobHandler {
  return async (job: EngineJob) => {
    // A connector job always belongs to a process instance; a missing key is a
    // protocol fault. Fail loud (the engine retries / raises an incident) rather
    // than handing the connector a fabricated "" that would silently corrupt any
    // instance-scoped call it makes.
    const processInstanceKey = job.processInstanceKey;
    if (processInstanceKey === undefined || processInstanceKey === "") {
      throw new Error(`connector job '${job.jobType}' (${job.jobKey}) has no processInstanceKey`);
    }
    let outcome:
      | { kind: "complete"; vars?: Record<string, unknown> }
      | { kind: "fail"; message: string }
      | { kind: "error"; code: string; message?: string }
      | undefined;
    const facade: ConnectorWorkerJob = {
      jobKey: job.jobKey,
      type: job.jobType,
      processInstanceKey,
      elementId: job.elementId,
      variables: job.variables,
      async complete(vars) {
        outcome = { kind: "complete", vars };
      },
      async fail(message) {
        outcome = { kind: "fail", message };
      },
      async error(code, message) {
        outcome = { kind: "error", code, message };
      },
    };
    const ret = await worker.handle(facade);
    if (outcome?.kind === "error") throw new BpmnError(outcome.code, outcome.message);
    if (outcome?.kind === "fail") throw new Error(outcome.message);
    if (outcome?.kind === "complete") return outcome.vars ?? {};
    // No explicit outcome: fall back to the handle's return value (SDK-style).
    return isRecord(ret) ? ret : {};
  };
}

/**
 * Mount every enabled connector worker (`workers[]` entries carrying a
 * `connector` field). Fails closed on a seam mismatch (an enabled connector whose
 * pack or worker type is not installed); skips-with-warning a worker whose
 * required env is unset (so a missing credential does not crash the app), or when
 * the host cannot host connector workers (`importConnectorModule` absent).
 */
export async function mountConnectors(ctx: RuntimeContext, app: AppApi): Promise<ConnectorsHandle> {
  const decls: Worker[] = (ctx.manifest.workers ?? []).filter((w) => Boolean(w.connector));
  const subs: WorkerSubscription[] = [];
  const jobTypes: string[] = [];
  if (decls.length === 0) return makeHandle(subs, jobTypes);

  const packs = await resolveInstalledConnectors(ctx);
  // Cache drained workers per imported entry (an entry may register several).
  const drainedByEntry = new Map<string, Map<string, DefinedConnectorWorker>>();

  for (const decl of decls) {
    const jobType = workerJobType(decl);
    if (!jobType) continue;
    const packId = decl.connector!;
    const pack = packs.get(packId);
    if (!pack) {
      throw new Error(
        `connector worker "${jobType}" references pack "${packId}", which is not installed ` +
          `(no dependency exposes a nano-ide.ext.json with id "${packId}"). Run \`urban add <pkg>\`.`,
      );
    }
    const spec = pack.manifest.workers?.find((w) => w.type === jobType);
    if (!spec) {
      throw new Error(
        `connector worker "${jobType}" is not provided by pack "${packId}" ` +
          `(its nano-ide.ext.json declares no worker of that type).`,
      );
    }

    const missing = requiredEnv(spec).filter((name) => !app.env(name));
    if (missing.length > 0) {
      ctx.host.log("warn", "skipping connector worker: required env unset", {
        jobType,
        connector: packId,
        missing: missing.join(", "),
      });
      continue;
    }

    if (!ctx.host.importConnectorModule) {
      ctx.host.log("warn", "skipping connector worker: host cannot host connector packs", {
        jobType,
        connector: packId,
        runtime: ctx.host.runtime,
      });
      continue;
    }

    const entryAbs = joinRoot(ctx.root, `${pack.dir}/${spec.entry}`);
    let drained = drainedByEntry.get(entryAbs);
    if (!drained) {
      await ctx.host.importConnectorModule(entryAbs);
      // Fail closed on a duplicate worker `type` within one pack entry: silently
      // keeping the last registration would bind an arbitrary handler.
      drained = new Map<string, ReturnType<typeof drainDefinedWorkers>[number]>();
      for (const w of drainDefinedWorkers()) {
        if (drained.has(w.type)) {
          throw new Error(
            `connector pack "${packId}" entry "${spec.entry}" registered the worker ` +
              `type "${w.type}" more than once (duplicate defineWorker call).`,
          );
        }
        drained.set(w.type, w);
      }
      drainedByEntry.set(entryAbs, drained);
    }
    const worker = drained.get(jobType);
    if (!worker) {
      throw new Error(
        `connector pack "${packId}" entry "${spec.entry}" did not register a worker for ` +
          `"${jobType}" (its defineWorker call declares a different type).`,
      );
    }

    const inner = adaptConnectorHandler(worker);
    const wrapped: JobHandler = (job) =>
      runInJobContext(
        { instanceKey: job.processInstanceKey, elementId: job.elementId, jobType },
        () => inner(job),
      );
    const sub = await ctx.engine.registerWorker(jobType, wrapped, {
      workerName: `${ctx.manifest.id}:${jobType}`,
      // The pack's `defineWorker({ maxParallelJobs })` is the authoritative runtime
      // value; the ext.json spec is a design-time default when the code omits it.
      maxParallelJobs: worker.maxParallelJobs ?? spec.maxParallelJobs,
    });
    subs.push(sub);
    jobTypes.push(jobType);
    ctx.host.log("info", "connector worker registered", { jobType, connector: packId });
  }

  return makeHandle(subs, jobTypes);
}

function makeHandle(subs: WorkerSubscription[], jobTypes: string[]): ConnectorsHandle {
  return {
    name: "connectors",
    jobTypes,
    async stop() {
      await Promise.allSettled(subs.map((s) => s.unsubscribe()));
    },
    describe: () => ({ jobTypes }),
  };
}
