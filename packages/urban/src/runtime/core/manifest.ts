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
import { isRecord } from "./guards.ts";
import type {
  AppManifest,
  InstanceTracking as SchemaInstanceTracking,
  Worker,
} from "@nanobpm/nano-app-schema";

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

/**
 * `instanceTracking` binding, bridged to add the fail-open `terminalStatuses` selector and the
 * `onWaitingHuman` wait-on-human edge (issue #355).
 *
 * `terminalStatuses` is landing in the canonical schema (`@nanobpm/nano-app-schema`,
 * Magikcraft/nano-bpm#769): an exclusion list — the runtime polls every row whose
 * `statusField` is NOT in it — so a newly-added non-terminal status is reconciled by
 * default instead of silently dropping out of an allow-list. Until that publishes and this
 * package's dep is bumped, extend the schema type here so the reconciler can consume the
 * field. Drop this augmentation and re-export `InstanceTracking` from the schema once the
 * dep bump lands (No Drift Surfaces).
 */
export type InstanceTracking = SchemaInstanceTracking & {
  /** Values of `statusField` considered finished. When set, every row NOT in one of these
   *  is polled (fail-open). Requires `statusField`; mutually exclusive with `activeStatuses`. */
  readonly terminalStatuses?: readonly string[];
  /**
   * The reconciliation applied to a row whose instance is **parked waiting on a human** — the
   * wait-state twin of {@link SchemaInstanceTracking.onTerminated} (issue #355). An instance is
   * waiting on a human *iff* it has an open user task, so the runtime derives this edge from
   * engine truth (`openUserTasks`) rather than from a written column: on each poll, an active,
   * non-terminated row whose instance has any open user task has this patch applied (typically
   * `status = "awaiting_operator"`). Terminated wins over waiting-human (the {@link
   * SchemaInstanceTracking.onTerminated} edge is applied first and excludes the key from this
   * pass); a row with neither a terminated instance nor an open user task is left untouched, so
   * the worker-owned transient status (running / converging / merging) survives.
   *
   * Optional and, like `terminalStatuses`, bridged locally until the canonical schema
   * (`@nanobpm/nano-app-schema`) folds it in; drop this augmentation and re-export once the dep
   * bump lands (No Drift Surfaces).
   */
  readonly onWaitingHuman?: {
    /** Column → literal value patch written to a row whose instance has an open user task
     *  (e.g. set the status to a "waiting on human" value). */
    readonly set: { readonly [k: string]: string | number | boolean | null };
  };
};

/**
 * A status selector (`activeStatuses`/`terminalStatuses`) counts as *configured* only when it is
 * a non-empty array of non-empty strings. Both the reconciler's row selection and the manifest
 * validator gate on this one predicate, so "is this selector active?" has a single definition and
 * the two can't drift (No Drift Surfaces). Anything else — `undefined`, an empty array, a bare
 * string, or an array holding a non-string/empty entry — is treated as *not configured*: the
 * reconciler falls through to the fail-open poll-all path and the validator flags the malformed
 * shape at author time (rather than letting e.g. `new Set("abandoned")` silently become a set of
 * characters, or `activeStatuses.map(...)` crash on a non-array).
 */
export function isConfiguredStatusSelector(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
}

/** The job type a worker subscribes to (schema key: `taskType`). */
export function workerJobType(w: Worker): string | undefined {
  return w.taskType;
}

/**
 * The valid HTTP bind modes, in declaration order. This is the single runtime source of
 * truth for the set: {@link BindMode}, {@link isBindMode}, and the manifest validator
 * (`collectManifestIssues`) all derive from it, so the allowed values live in one place.
 */
export const BIND_MODES = ["loopback", "all"] as const;

/**
 * Which interface the app's embedded HTTP server binds to (issue #235):
 *  - `"loopback"` (default): `127.0.0.1` — secure-by-default; refuses off-box connections.
 *  - `"all"`: `0.0.0.0` — reachable from other hosts on the LAN (distributed worker fleet).
 */
export type BindMode = (typeof BIND_MODES)[number];

/**
 * App-level network settings (issue #235). Absent ⇒ loopback.
 *
 * Mirrored locally — like the `api` binding (ADR 0058) — until `@nanobpm/nano-app-schema`
 * folds `network` into `AppManifest` (the schema PR lands first). The manifest shape is
 * owned by that package (ADR 0027), so we deliberately do NOT augment `AppManifest` via
 * `declare module` (CI bans it): the field is threaded through the runtime-side helpers
 * that take a `{ network?: NetworkConfig }` view and is read off the raw manifest object.
 * Once the schema ships `network`, this local type (and the allow-list entry in
 * validate.ts) can be deleted and the field flows from the schema like every other block.
 */
export interface NetworkConfig {
  /** HTTP bind interface. Default `"loopback"`. */
  bind?: BindMode;
}

/**
 * The keys the runtime-side `network` block understands, as the single source of truth for
 * the validator's `additionalProperties: false` check under `network`. Typed as
 * `(keyof NetworkConfig)[]` so it can only ever list real {@link NetworkConfig} keys — a
 * drift test (`manifest.test.ts`) asserts it stays complete as the block grows.
 */
export const NETWORK_KEYS: readonly (keyof NetworkConfig)[] = ["bind"];

/** A runtime-side view of a manifest carrying the pending-schema `network` block. */
export interface WithNetwork {
  network?: NetworkConfig;
}

/** Loopback bind address — secure/local default. */
export const LOOPBACK_HOST = "127.0.0.1";
/** All-interfaces IPv4 bind address — LAN / distributed fleet. */
export const ALL_INTERFACES_HOST = "0.0.0.0";

/** Environment variable that overrides the manifest bind mode for ops. */
export const BIND_ENV_VAR = "URBAN_BIND";

/** True when `v` is a valid {@link BindMode}. */
export function isBindMode(v: unknown): v is BindMode {
  return BIND_MODES.some((mode) => mode === v);
}

/**
 * Read the pending-schema `network.bind` off a raw manifest object. Because `network` is
 * mirrored locally (not yet in `AppManifest`'s static shape), it is read reflectively —
 * the same way the `api` binding is threaded (ADR 0058) — and validated with
 * {@link isBindMode} so this always returns a real {@link BindMode} or `undefined`.
 */
function manifestBind(manifest: AppManifest | WithNetwork): BindMode | undefined {
  const network = Reflect.get(manifest, "network");
  if (!isRecord(network)) return undefined;
  return isBindMode(network.bind) ? network.bind : undefined;
}

/**
 * Resolve the effective HTTP bind mode: the `URBAN_BIND` env override wins when set to a
 * valid value, else the manifest's `network.bind`, else `"loopback"` (secure by default).
 * An env value that is present but invalid is ignored (falls through to the manifest/default);
 * callers that want to surface that can check {@link isBindMode} on the raw env value.
 */
export function resolveBindMode(
  manifest: AppManifest | WithNetwork,
  lookup: (name: string) => string | undefined = () => undefined,
): BindMode {
  const envRaw = lookup(BIND_ENV_VAR);
  if (isBindMode(envRaw)) return envRaw;
  return manifestBind(manifest) ?? "loopback";
}

/** Map a {@link BindMode} to the concrete host address passed to the HTTP adapter. */
export function bindModeToHost(mode: BindMode): string {
  return mode === "all" ? ALL_INTERFACES_HOST : LOOPBACK_HOST;
}

/**
 * Resolve the concrete bind host address from the manifest + environment.
 * `"loopback"` ⇒ `127.0.0.1` (default), `"all"` ⇒ `0.0.0.0`.
 */
export function resolveBindHost(
  manifest: AppManifest | WithNetwork,
  lookup: (name: string) => string | undefined = () => undefined,
): string {
  return bindModeToHost(resolveBindMode(manifest, lookup));
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
