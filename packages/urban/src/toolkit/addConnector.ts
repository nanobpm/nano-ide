// addConnector — enable an installed connector pack into an app's nano.app.json.
//
// A connector pack ships a `nano-ide.ext.json` manifest declaring one or more
// workers (a `taskType`, a worker `entry`, and its config fields). "Enabling" it
// means the pure, idempotent manifest edit the `urban add` CLI performs after
// `npm install <pkg>` (ADR 0050 §5): for every worker the pack declares, append a
// pack-backed `workers[]` entry (`{ taskType, connector: <pack-id>, connection }`)
// and, when the pack needs credentials, a named `connections[]` entry whose values
// are env-pointer templates (never inline secrets, ADR 0025 §1 / 0027 §5).
//
// This module only reads/writes files through the GenIO port — installing the
// package (a subprocess) is the CLI's job, so this stays runtime-agnostic and
// unit-testable.

import type { GenIO } from "./gen.ts";
import { errorMessage, isRecord } from "../runtime/core/guards.ts";
import { detectJsonIndent } from "./scaffold.ts";

/** A config field a pack declares (subset of ext-types `ConfigField`). */
interface PackConfigField {
  key: string;
  label?: string;
  env?: string;
  default?: string;
}

/** A worker a pack declares (subset of ext-types `WorkerSpec`). */
interface PackWorkerSpec {
  type: string;
  entry: string;
  displayName?: string;
  maxParallelJobs?: number;
  configFields?: PackConfigField[];
}

/** The pack manifest (`nano-ide.ext.json`) fields `addConnector` reads. */
interface PackManifest {
  id: string;
  workers?: PackWorkerSpec[];
}

export interface AddConnectorOptions {
  /** App root directory. */
  root: string;
  /** The installed npm package name (already present under node_modules). */
  pkg: string;
  /** Manifest filename under root. Default "nano.app.json". */
  manifestFile?: string;
  io: GenIO;
}

export interface AddConnectorResult {
  /** The pack id (`nano-ide.ext.json` `id`) written to each worker's `connector`. */
  packId: string;
  /** Workers considered, with whether one was already wired (idempotent). */
  wired: { taskType: string; alreadyPresent: boolean }[];
  /** The named connection created/reused, if the pack needs credentials. */
  connection?: string;
  /** Env vars the operator must set for the enabled workers to run. */
  requiredEnv: string[];
}

const MANIFEST_FILE = "nano-ide.ext.json";

function joinPath(a: string, b: string): string {
  // Trim both slash styles (as toolkit/gen.ts joinPath does) so a Windows-style
  // root does not produce an invalid path.
  return `${a.replace(/[/\\]+$/, "")}/${b.replace(/^[/\\]+/, "")}`;
}

/** A stable, slug-ish connection name for a pack id (kebab, no leading scope). */
function connectionNameFor(packId: string): string {
  const base = packId.includes("/") ? packId.slice(packId.lastIndexOf("/") + 1) : packId;
  return base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || packId;
}

/**
 * Read the installed pack manifest, then wire its workers into the app manifest.
 * Idempotent: re-running never duplicates a `workers[]`/`connections[]` entry.
 * The app manifest object is mutated in place and written back.
 */
export async function addConnector(opts: AddConnectorOptions): Promise<AddConnectorResult> {
  const { root, pkg, io } = opts;
  const manifestFile = opts.manifestFile ?? "nano.app.json";

  const packManifestPath = joinPath(joinPath(joinPath(root, "node_modules"), pkg), MANIFEST_FILE);
  if (!(await io.exists(packManifestPath))) {
    throw new Error(
      `"${pkg}" is not an Urban connector: no ${MANIFEST_FILE} found at ${packManifestPath}. ` +
        `Install the package first (\`npm install ${pkg}\`), and check it is a connector pack.`,
    );
  }
  let pack: PackManifest;
  try {
    pack = JSON.parse(await io.readText(packManifestPath));
  } catch (err) {
    throw new Error(`failed to parse ${packManifestPath}: ${errorMessage(err)}`);
  }
  if (typeof pack.id !== "string" || !pack.id) {
    throw new Error(`${packManifestPath} has no string "id" (a pack must declare its id).`);
  }
  const specs = Array.isArray(pack.workers) ? pack.workers : [];
  if (specs.length === 0) {
    throw new Error(`connector pack "${pack.id}" declares no workers[] — nothing to enable.`);
  }
  // `type` comes from JSON; a malformed pack must fail loudly rather than wire an
  // invalid worker entry (or manufacture a confusing conflict).
  for (const spec of specs) {
    if (typeof spec.type !== "string" || spec.type.length === 0) {
      throw new Error(
        `connector pack "${pack.id}" has a worker with a missing/non-string "type" in ${packManifestPath}.`,
      );
    }
  }

  const appManifestPath = joinPath(root, manifestFile);
  if (!(await io.exists(appManifestPath))) {
    throw new Error(`no ${manifestFile} at ${appManifestPath} — run this inside an Urban app.`);
  }
  let appRaw: string;
  let app: {
    workers?: { taskType?: string; connector?: string; connection?: string; handler?: string; llm?: string }[];
    connections?: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
  };
  try {
    appRaw = await io.readText(appManifestPath);
    app = JSON.parse(appRaw);
  } catch (err) {
    throw new Error(`failed to parse ${appManifestPath}: ${errorMessage(err)}`);
  }
  if (app === null || typeof app !== "object" || Array.isArray(app)) {
    throw new Error(`${appManifestPath} is not a JSON object.`);
  }
  if (app.workers !== undefined && !Array.isArray(app.workers)) {
    throw new Error(`${appManifestPath} "workers" must be an array.`);
  }
  if (
    app.connections !== undefined &&
    (app.connections === null || typeof app.connections !== "object" || Array.isArray(app.connections))
  ) {
    throw new Error(`${appManifestPath} "connections" must be an object.`);
  }
  const workers = (app.workers ??= []);

  // Required env across the pack's workers (env-pointer fields without a default).
  const envFields: PackConfigField[] = [];
  const requiredEnvSet = new Set<string>();
  for (const spec of specs) {
    for (const f of spec.configFields ?? []) {
      if (f.env) {
        envFields.push(f);
        if (f.default === undefined || f.default === "") requiredEnvSet.add(f.env);
      }
    }
  }

  // Create/reuse a named connection when the pack carries credential config, so the
  // required env pointers are documented in the manifest (secrets stay templates).
  let connection: string | undefined;
  if (envFields.length > 0) {
    connection = connectionNameFor(pack.id);
    const connections = (app.connections ??= {});
    const existing = connections[connection];
    if (existing === undefined) {
      const conn: Record<string, unknown> = { type: pack.id };
      for (const f of envFields) {
        if (!(f.key in conn) && f.env) conn[f.key] = `\${${f.env}}`;
      }
      connections[connection] = conn;
    } else {
      // A pre-existing connection of this name must be a compatible object of the
      // same pack `type`; otherwise wiring workers to it would produce an invalid
      // or misleading manifest. Fail loudly instead of silently reusing it.
      if (!isRecord(existing)) {
        throw new Error(`connection "${connection}" already exists and is not an object.`);
      }
      const conn = existing;
      if (conn.type !== undefined && conn.type !== pack.id) {
        throw new Error(
          `connection "${connection}" already exists with type "${String(conn.type)}", ` +
            `not "${pack.id}".`,
        );
      }
      // Backfill the pack's `type` and any missing env-pointer templates.
      if (conn.type === undefined) conn.type = pack.id;
      for (const f of envFields) {
        if (!(f.key in conn) && f.env) conn[f.key] = `\${${f.env}}`;
      }
    }
  }

  const wired: { taskType: string; alreadyPresent: boolean }[] = [];
  for (const spec of specs) {
    const existing = workers.find((w) => w.taskType === spec.type);
    if (existing) {
      // A same-taskType worker backed by a handler/llm or a different connector is
      // a real conflict — enabling this pack would not take effect. Fail loudly
      // instead of reporting a false success.
      if (existing.connector !== pack.id) {
        const backing = existing.handler
          ? `handler "${existing.handler}"`
          : existing.llm
            ? `llm "${existing.llm}"`
            : existing.connector
              ? `connector "${existing.connector}"`
              : "another backing";
        throw new Error(
          `worker "${spec.type}" is already declared with ${backing}; ` +
            `remove it before enabling connector "${pack.id}" for that taskType.`,
        );
      }
      wired.push({ taskType: spec.type, alreadyPresent: true });
      // Heal an entry that references the pack but predates the connection.
      if (connection && !existing.connection) {
        existing.connection = connection;
      }
      continue;
    }
    const entry: { taskType: string; connector: string; connection?: string } = {
      taskType: spec.type,
      connector: pack.id,
    };
    if (connection) entry.connection = connection;
    workers.push(entry);
    wired.push({ taskType: spec.type, alreadyPresent: false });
  }

  // Preserve the manifest's own indentation (default tab, matching the scaffold's Biome config)
  // so enabling a connector never reformats nano.app.json out from under `npm run lint` — the same
  // fidelity `urban gen` gives via detectJsonIndent, kept as the single source of truth.
  await io.writeText(appManifestPath, `${JSON.stringify(app, null, detectJsonIndent(appRaw))}\n`);

  return {
    packId: pack.id,
    wired,
    connection,
    requiredEnv: [...requiredEnvSet],
  };
}
