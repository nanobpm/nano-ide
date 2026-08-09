// Manifest types + env-placeholder expansion + a host-driven loader.
//
// The App manifest contract (nano.app.json) is owned by the canonical
// @nanobpm/nano-app-schema package (ADR 0027): the JSON Schema and its generated
// TypeScript types are the single source of truth. This module re-exports those
// types (type-only, so nothing from the package is pulled into the runtime
// bundle) and adds the runtime-side helpers the App loader needs. No shape is
// hand-mirrored here — that eliminated the schema/type drift the vendored copies
// used to cause.

import type { HostContext } from "./host.ts";
import type { AppManifest, Worker } from "@nanobpm/nano-app-schema";

export type {
  ActionDecl,
  AppManifest,
  AppUi,
  ChatSurface,
  Connection,
  Data,
  DataSource,
  DomainField,
  DomainType,
  InstanceTracking,
  LlmBinding,
  Models,
  PagesSurface,
  Runtime,
  Security,
  Surfaces,
  TaskInboxSurface,
  Trigger,
  TriggerAction,
  Worker,
} from "@nanobpm/nano-app-schema";

/** The job type a worker subscribes to (schema key: `taskType`). */
export function workerJobType(w: Worker): string | undefined {
  return w.taskType;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` placeholders in a string using `lookup`.
 * Unset vars with no default expand to "" (matching common shell semantics).
 */
export function expandEnvString(input: string, lookup: (name: string) => string | undefined): string {
  return input.replace(ENV_RE, (_m, name: string, dflt: string | undefined) => {
    const v = lookup(name);
    if (v !== undefined && v !== "") return v;
    return dflt ?? "";
  });
}

/** Recursively expand env placeholders across every string in a JSON-ish value. */
export function expandEnv<T>(value: T, lookup: (name: string) => string | undefined): T;
export function expandEnv(value: unknown, lookup: (name: string) => string | undefined): unknown {
  if (typeof value === "string") return expandEnvString(value, lookup);
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, lookup));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, lookup);
    return out;
  }
  return value;
}

/** Parse a manifest from JSON text and expand env placeholders. Does not validate. */
export function parseManifest(
  json: string,
  lookup: (name: string) => string | undefined = () => undefined,
): AppManifest {
  const raw: AppManifest = JSON.parse(json);
  return expandEnv(raw, lookup);
}

/** Load and parse the manifest from the app root using the host (env-expanded). */
export async function loadManifest(host: HostContext, manifestPath: string): Promise<AppManifest> {
  const text = await host.readTextFile(manifestPath);
  return parseManifest(text, (n) => host.env(n));
}
