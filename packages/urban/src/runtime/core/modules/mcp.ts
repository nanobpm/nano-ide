// mcp — the runtime-served Model Context Protocol surface (ADR 0067). A Streamable-HTTP MCP
// endpoint the Urban runtime mounts UNCONDITIONALLY at `/app/mcp` (it answers `POST`, plus `DELETE`
// to end a session; the optional `GET` server→client stream is declined with 405 at the string-body
// host seam), exactly like the `/app/agent` brief and `/app/api-docs` docs surfaces — so an MCP
// client (`copilot mcp add
// --transport http <name> http://localhost:<port>/app/mcp`) discovers an app's operations as
// tools with ZERO app-side MCP code.
//
// Derive-don't-declare (ADR 0053): the app tool list is PROJECTED from the SAME OpenAPI
// enumeration `mountApi` routes from — `parseSpec` + `collectOperations` (openapi/spec.ts), read
// through `readApiBinding` — never a second spec walker. Each projected operation becomes one tool
// whose `operationId` is the tool name and whose request-body/params schema is the tool input
// schema; a tool call is reconstructed into the operation's HTTP request and dispatched through the
// SAME `mountApi` router, so it flows through the identical delegate registry + validation the HTTP
// route uses (a tool call is equivalent to the corresponding HTTP call).
//
// This module (ADR 0067) exposes app operations as MCP tools — each authorized exactly as its own
// HTTP route by the operation's OpenAPI `security` (a read or mutating op with no `security` is
// open; there is NO extra MCP-level shared-secret guard on app operations). An operation opts out
// of projection with the `x-mcp` extension. It also exposes framework-owned process-debugging tools
// over BOTH truth planes: engine truth via existing `EngineClient` methods (reads, plus mutating
// unstick tools — cancel/resolve/retry/set-variables, which ARE guarded by the app's shared secret
// or the `mcp.allowMutations` opt-in), and the ADR 0065 canonical projection stores
// (`urban_instance_state` / `urban_open_user_tasks`).
// The app's system brief (`/app/agent.json`) is served as an MCP resource, plus one orientation
// entry under MCP prompts.
//
// Transport: the SDK's Web-Standard Streamable-HTTP transport (`Request`→`Response`), bridged to
// the runtime's host `HttpRequest`/`HttpResponse` seam — core/ imports no `node:*`; the MCP SDK is
// an ordinary dependency. Access is loopback-only behind a manifest/env flag that defaults ON for
// loopback.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { GENERATED_DIR } from "../../../toolkit/artifact.ts";
import { SYSTEM_BRIEF_JSON } from "../../../toolkit/derivers/system-brief.ts";
import {
  collectOperations,
  evaluateSecurity,
  isMutatingMethod,
  isObjectSchema,
  type OpenApiDoc,
  type OpenApiSchema,
  type OperationInfo,
  parseSpec,
  resolveSchema,
  schemaHasType,
  type SecurityDecision,
  sharedSecretSchemeName,
  toolInputSchema,
} from "../../../openapi/spec.ts";
import type { AppApi, RuntimeContext } from "../context.ts";
import { errorMessage } from "../guards.ts";
import type {
  ElementInstanceWaitStateFilter,
  EngineIncidentState,
  HttpRequest,
  HttpResponse,
  IncidentFilter,
  ProcessInstanceState,
  SqliteDb,
  UserTaskFilter,
  UserTaskState,
  WaitStateType,
} from "../host.ts";
import { presentFormIdentifier } from "../host.ts";
import { resolveBindMode } from "../manifest.ts";
import { json, makeRouter, type Route } from "../router.ts";
import { API_BASE, readApiBinding } from "./api.ts";
import { resolveAppPath } from "./datasource.ts";
import { InstanceStateStore } from "./instance-state-store.ts";
import { OpenUserTasksStore } from "./open-user-tasks-store.ts";

/** The mount path of the MCP endpoint — a sibling of `/app/api` / `/app/agent`, mounted
 *  unconditionally so an MCP client always has a stable address to connect to. */
const MCP_PATH = "/app/mcp";

/** The header carrying the Streamable-HTTP session id (MCP spec). */
const SESSION_HEADER = "mcp-session-id";

/** Hard upper bound on concurrently-resident MCP sessions. Each session is a live `Server` +
 *  transport pair, so an unbounded session map is a memory/handle-exhaustion vector: any local
 *  process can repeatedly `initialize` without reusing its `mcp-session-id` and pin a fresh pair
 *  each time. Capping the map (LRU-evicted, refreshed on use — see `evictExcessSessions` /
 *  `touchSession`) categorically bounds growth regardless of client behaviour or timing. */
const MAX_SESSIONS = 256;

/** The MCP resource URI for the app's system brief (the `/app/agent.json` content). */
const SYSTEM_BRIEF_URI = "urban://system-brief.json";

/** The single orientation prompt registered under MCP `prompts`. */
const ORIENTATION_PROMPT = "urban-orientation";

/** The framework debug-tool name prefix — a reserved namespace. `loadReadOnlyOps` drops any app
 *  `operationId` in this namespace before it is projected as a tool, so a framework tool can never
 *  collide with (be shadowed by, or duplicate the name of) an app-projected tool. */
const DEBUG_PREFIX = "urban_debug_";

export interface McpHandle {
  readonly name: string;
  routes: Route[];
  /** Whether the surface actually answers vs. 404s (config-enabled). The route is always mounted
   *  for a stable address, so callers deriving an "active surfaces" list must gate on this. */
  readonly enabled: boolean;
  describe(): Record<string, unknown>;
}

/** Mint a fresh MCP session id, host-agnostically. Prefers the Web Crypto `randomUUID` (a global,
 *  not `node:crypto`) where present, with a time+random fallback so a host without `crypto` never
 *  throws — mirroring how core treats Web Crypto as optional (see `mintRootRequestKey`). */
export function newSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Mark a session as most-recently-used. A `Map` preserves insertion order, so deleting and
 *  re-inserting a live entry moves it to the tail — which makes the first key the least-recently-used
 *  entry that `evictExcessSessions` reaps first. Refreshing on every use is what keeps an active
 *  session from being evicted out from under a client that is still talking to it. */
function touchSession<S>(sessions: Map<string, S>, id: string, session: S): void {
  sessions.delete(id);
  sessions.set(id, session);
}

/** Bound the live-session map to `max` by evicting least-recently-used entries (the `Map`'s leading
 *  keys, given `touchSession` re-inserts on use), closing each victim best-effort so its transport /
 *  server releases. This is the categorical fix for the unbounded-growth vector: no client can pin
 *  more than `max` server/transport pairs, whatever its `initialize` cadence. Exported for a direct
 *  unit test of the LRU eviction contract. */
export async function evictExcessSessions<S>(
  sessions: Map<string, S>,
  max: number,
  close: (session: S) => Promise<void>,
): Promise<void> {
  while (sessions.size > max) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    const victim = sessions.get(oldest);
    sessions.delete(oldest);
    if (victim !== undefined) {
      try {
        await close(victim);
      } catch {
        // Best-effort: a victim whose transport is already torn down must not abort eviction.
      }
    }
  }
}


/** The resolved MCP access policy for this app. */
interface McpConfig {
  /** Whether the MCP surface answers at all. Defaults ON. */
  readonly enabled: boolean;
  /** Whether non-loopback callers are allowed. Defaults OFF (loopback-only). */
  readonly allowRemote: boolean;
  /** Explicit runtime opt-in that authorizes the framework MUTATING debug tools WITHOUT a
   *  shared-secret credential (ADR 0067 Slice 3). Defaults OFF: mutations then require the app's
   *  shared secret. An operator sets this to open mutations on a trusted, credential-less setup
   *  (e.g. a purely local debugging box). It is honoured LOOPBACK-ONLY: when `allowRemote` is also
   *  enabled the credential-free bypass is ignored and remote mutations still require the shared
   *  secret, so opening the surface to non-loopback callers can never silently expose unguarded
   *  mutating tools. */
  readonly allowMutations: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve the MCP access policy from the manifest
 * (`mcp: { enabled?, allowRemote?, allowMutations? }`, read reflectively until the app schema folds
 * the field in — mirroring how `readApiBinding` reads `api`) and the environment
 * (`URBAN_MCP_ENABLED`, `URBAN_MCP_ALLOW_REMOTE`, `URBAN_MCP_ALLOW_MUTATIONS`). The env flags win so
 * an operator can force the surface off (or open it to a non-loopback bind, or enable mutating
 * tools) without editing the manifest. Enabled defaults ON and access defaults to loopback-only
 * ("defaults ON for loopback"); `allowMutations` defaults OFF (mutating tools stay closed).
 */
export function readMcpConfig(manifest: unknown, env: (name: string) => string | undefined): McpConfig {
  const raw = manifest && typeof manifest === "object" ? Reflect.get(manifest, "mcp") : undefined;
  // Honour manifest flags only when they are actual booleans (mirroring `readApiBinding`'s strict
  // type checks), so a stray non-boolean value falls back to the default instead of coercing
  // surprisingly (e.g. the string `"false"` is not a boolean `false`).
  const rawEnabled = isRecord(raw) ? Reflect.get(raw, "enabled") : undefined;
  const rawAllowRemote = isRecord(raw) ? Reflect.get(raw, "allowRemote") : undefined;
  const rawAllowMutations = isRecord(raw) ? Reflect.get(raw, "allowMutations") : undefined;
  const manifestEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
  const manifestAllowRemote = typeof rawAllowRemote === "boolean" ? rawAllowRemote : undefined;
  const manifestAllowMutations = typeof rawAllowMutations === "boolean" ? rawAllowMutations : undefined;
  const envEnabled = env("URBAN_MCP_ENABLED");
  const envAllowRemote = env("URBAN_MCP_ALLOW_REMOTE");
  const envAllowMutations = env("URBAN_MCP_ALLOW_MUTATIONS");
  const enabled = envEnabled === "false" ? false : envEnabled === "true" ? true : manifestEnabled !== false;
  const allowRemote =
    envAllowRemote === "true" ? true : envAllowRemote === "false" ? false : manifestAllowRemote === true;
  const allowMutations =
    envAllowMutations === "true" ? true : envAllowMutations === "false" ? false : manifestAllowMutations === true;
  return { enabled, allowRemote, allowMutations };
}

/** The host portion of an HTTP `Host` header, lower-cased and stripped of any `:port` (and of the
 *  `[...]` brackets around an IPv6 literal), or `undefined` when there is no Host header. */
function hostName(req: HttpRequest): string | undefined {
  const host = req.headers.get("host");
  if (!host) return undefined;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

/** Whether the request targets a loopback host — the best-effort loopback signal available at the
 *  host seam (which carries no peer address). A missing Host header is treated as loopback (a direct
 *  local client that sent none). */
export function isLoopbackRequest(req: HttpRequest): boolean {
  const name = hostName(req);
  return name === undefined || name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/** Read a header value from the SDK's per-request `requestInfo.headers` map (lower-cased keys,
 *  values `string | string[] | undefined`). A repeated header (`string[]`, as Node's raw adapter
 *  surfaces it) is comma-joined to MATCH `Headers.get()` semantics — the same read `mountApi` and
 *  the reconstructed `toHttpRequest` use for OpenAPI route enforcement — so the shared-secret guard
 *  cannot diverge from route enforcement on a repeated credential header. Returns `undefined` when
 *  absent. Used to read the shared-secret credential the client presents on the MCP connection for a
 *  mutating tool call. */
export function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

/** A minimal read of the `x-mcp` extension for a projected operation is done at parse time
 *  (`OperationInfo.mcpExcluded`); here we only need the mutation classification, shared with the CI
 *  parity guard via {@link isMutatingMethod}. Kept as a named predicate for readability at the call
 *  sites (tool annotations + guard). */
function isMutatingOperation(op: OperationInfo): boolean {
  return isMutatingMethod(op.method);
}

/** A JSON Schema (OpenAPI object subset) describing a tool's input is derived once, in
 *  `openapi/spec.ts`'s {@link toolInputSchema}, from an operation's resolved (`$ref`-free) parameter
 *  and request-body metadata — so the tool input schema the runtime advertises and the schema the CI
 *  parity guard pins are the SAME derivation (one source of truth, ADR 0053/0067). */

/** Substitute an operation's `{param}` path-template segments with the supplied arguments, building
 *  the request path under the shared `/app/api` base so dispatch hits the exact `mountApi` route. */
function fillPath(op: OperationInfo, args: Record<string, unknown>): string {
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = args[name];
    return encodeURIComponent(value === undefined || value === null ? "" : String(value));
  });
  return `${API_BASE}${path}`;
}

/** Build the query string for a tool call from the operation's declared query parameters and the
 *  supplied arguments — repeated (array) values become repeated keys, exactly as an HTTP client
 *  would send them, so the reused dispatcher validates identical input. */
function toolQuery(op: OperationInfo, args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(p.name, String(item));
    } else {
      query.append(p.name, String(value));
    }
  }
  return query;
}

/** Whether an argument is absent for presence purposes: unset (`undefined`/`null`), or a string that
 *  is empty or whitespace-only after trimming. This is the trimmed-presence rule
 *  {@link presentFormIdentifier} enforces for form identifiers, reused here so MCP required/path args
 *  and form resolution cannot drift on what "provided" means (a whitespace-only `"   "` is absent in
 *  both). A non-string value (e.g. a numeric path id) is considered present. */
function isBlankArg(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return presentFormIdentifier(value) === undefined;
  return false;
}

/** The required path parameters an operation declares that the tool `args` did not supply. Unlike
 *  an HTTP request (whose path can't structurally omit a segment), a tool call can leave a
 *  `{param}` unset or blank; `fillPath` would then substitute an empty string and silently mis-route
 *  (a 404 route mismatch, or worse a different route shape), so a missing/blank path arg is rejected
 *  up front. Blankness uses the shared trimmed-presence rule so a whitespace-only value is rejected
 *  too. */
function missingPathParams(op: OperationInfo, args: Record<string, unknown>): string[] {
  return op.parameters
    .filter((p) => p.in === "path" && isBlankArg(args[p.name]))
    .map((p) => p.name);
}

/** The `required` keys a tool's `inputSchema` declares but the call omitted. Presence is decided
 *  solely by {@link isBlankArg} — the single source of truth also used for path args — so a value is
 *  "provided" unless it is absent (`undefined`/`null`) or a blank/whitespace-only string. A required
 *  non-string input (e.g. a numeric/boolean/object arg) that is present is therefore accepted, not
 *  wrongly reported missing. Derived from the schema's own `required` array so declaring a field
 *  required is enough to have missing (or whitespace-only) calls rejected rather than silently
 *  substituted with an empty string. */
export function missingRequiredArgs(inputSchema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = inputSchema.required;
  if (!Array.isArray(required)) return [];
  const missing: string[] = [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (isBlankArg(args[key])) missing.push(key);
  }
  return missing;
}

/** Reconstruct the HTTP request an operation tool call is equivalent to, ready to hand to the
 *  reused `mountApi` router. The JSON body is the tool's `body` argument (when the op declares one).
 *  The MCP connection's request headers are FORWARDED (with `content-type` pinned to JSON) so the
 *  reused router's `evaluateSecurity` sees the client's credential: a mutating (or a secured
 *  read-only) app operation is then guarded exactly as its HTTP route is — the app operation tools
 *  inherit the OpenAPI `security` contract rather than a bespoke MCP gate (ADR 0067 §4). */
function toHttpRequest(
  op: OperationInfo,
  args: Record<string, unknown>,
  forwardHeaders: Record<string, string | string[] | undefined>,
): HttpRequest {
  // `args.body` is expected to already be the structured value the operation declares — a
  // pre-encoded JSON-string body is normalized upstream by `normalizeBodyArg` (called in
  // `dispatchOperationTool`) so `JSON.stringify` here serializes an object/array ONCE rather than
  // double-encoding a quoted string the door would reject (ADR 0067).
  const bodyText = op.requestBodySchema !== undefined && args.body !== undefined
    ? JSON.stringify(args.body)
    : "";
  const headers = new Headers();
  for (const [key, value] of Object.entries(forwardHeaders)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  headers.set("content-type", "application/json");
  return {
    method: op.method.toUpperCase(),
    path: fillPath(op, args),
    query: toolQuery(op, args),
    headers,
    text: () => Promise.resolve(bodyText),
  };
}

/** The operation's effective request-body schema for classifying a tool-call `body`: P0's resolved,
 *  `$ref`-free schema ({@link OperationInfo.requestBodySchemaResolved}, produced by
 *  `collectOperations`). As defence in depth, if that metadata is somehow still a bare `$ref` (it
 *  should never be after resolution), re-resolve it via {@link resolveSchema} against `doc` so the
 *  classification below never keys off an opaque `#/components/...` pointer. */
export function effectiveRequestBodySchema(
  op: OperationInfo,
  doc: OpenApiDoc | undefined,
): OpenApiSchema | undefined {
  const schema = op.requestBodySchemaResolved ?? op.requestBodySchema;
  if (schema?.$ref) return doc ? resolveSchema(doc, schema) : undefined;
  return schema;
}

/** Whether the operation declares a STRUCTURED (object/array) request body — the shapes the app door
 *  expects as a JSON object/array rather than a bare scalar. Classified from the RESOLVED schema so a
 *  `$ref`-bodied op (e.g. `previewDeliveryGraph`, whose object `type` is only visible after P0's
 *  resolution) is recognized, not merely an inline-`type` object body. */
export function structuredBodyKind(schema: OpenApiSchema | undefined): "object" | "array" | undefined {
  if (!schema) return undefined;
  if (isObjectSchema(schema)) return "object";
  if (schemaHasType(schema, "array")) return "array";
  return undefined;
}

/** Normalize a tool-call `body` argument for FAITHFUL transport (ADR 0067). A client that saw an
 *  opaque input schema — or that coerces non-primitive args — may send `body` as a pre-encoded JSON
 *  *string* instead of the object/array the operation declares. Left as-is, `toHttpRequest`'s
 *  `JSON.stringify` would DOUBLE-encode it into a quoted string and the door would reject it with
 *  "expected object, got string". So when the op declares an object/array body and `body` arrives as
 *  a string, parse it once so it round-trips as the structured value. A genuine object/array argument
 *  passes through untouched (still serialized by the transport). A string that does not parse to the
 *  declared shape is a CLEAR tool error naming the expected shape — never a silently double-encoded
 *  (and 4xx-rejected) request. */
export function normalizeBodyArg(
  op: OperationInfo,
  args: Record<string, unknown>,
  doc: OpenApiDoc | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const body = args.body;
  const kind = structuredBodyKind(effectiveRequestBodySchema(op, doc));
  if (body === undefined || kind === undefined || typeof body !== "string") {
    return { ok: true, args };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      error:
        `validation failed: the "body" argument was sent as a string but this operation expects a JSON ${kind}; the string is not valid JSON`,
    };
  }
  const parsedKind = Array.isArray(parsed)
    ? "array"
    : parsed !== null && typeof parsed === "object"
      ? "object"
      : undefined;
  if (parsedKind !== kind) {
    const got = parsedKind ?? (parsed === null ? "null" : typeof parsed);
    return {
      ok: false,
      error:
        `validation failed: the "body" argument was sent as a string but this operation expects a JSON ${kind}; it parsed to a ${got}`,
    };
  }
  return { ok: true, args: { ...args, body: parsed } };
}

/** Wrap a value as an MCP tool text result. A JSON payload is stringified; `isError` flags a
 *  non-2xx dispatch so the client sees the failure (carrying the delegate's own error body). */
function textResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** Read an OPTIONAL string argument in its TRIMMED present form, or `undefined` when it is missing,
 *  non-string, or blank/whitespace-only. The canonical read for identifying keys and filter values
 *  (processInstanceKey/elementId/assignee/candidateGroup): it applies the SAME
 *  {@link presentFormIdentifier} trimmed-presence rule that `missingRequiredArgs`/{@link isBlankArg}
 *  use for presence, so a padded value like `"  pi-1  "` normalizes to `"pi-1"` instead of reaching
 *  the engine untrimmed — where a filter would silently match nothing and a keyed lookup would target
 *  a whitespace-padded entity that does not exist. The single source of truth {@link requireString}
 *  also derives from, so required and optional reads cannot drift on how they normalize. */
function readPresentString(args: Record<string, unknown>, key: string): string | undefined {
  return presentFormIdentifier(readString(args, key));
}

/** Read a REQUIRED non-empty string argument, TRIMMED, or throw `InvalidParams`. The canonical guard
 *  the mutating debug tools use for their identifying keys (processInstanceKey/incidentKey/jobKey/
 *  scopeKey): a missing, non-string, or blank value fails fast before any engine state is touched,
 *  rather than silently degrading to `""` and performing a broken/misleading mutation. Derived from
 *  {@link readPresentString} — the same trimmed-presence rule {@link isBlankArg} (hence
 *  `missingRequiredArgs`) uses — so a padded key like `"  pi-1  "` cannot pass the required-arg check
 *  yet reach the engine untrimmed and mis-target the entity. */
function requireString(args: Record<string, unknown>, key: string): string {
  const present = readPresentString(args, key);
  if (present === undefined) throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  return present;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) if (typeof item === "string") out.push(item);
  return out;
}

function readProcessInstanceState(args: Record<string, unknown>, key: string): ProcessInstanceState | undefined {
  const v = args[key];
  return v === "ACTIVE" || v === "COMPLETED" || v === "TERMINATED" ? v : undefined;
}

function readUserTaskState(args: Record<string, unknown>, key: string): UserTaskState | undefined {
  const v = args[key];
  return v === "CREATED" || v === "COMPLETED" || v === "CANCELED" || v === "FAILED" ? v : undefined;
}

function readWaitStateType(args: Record<string, unknown>, key: string): WaitStateType | undefined {
  const v = args[key];
  return v === "JOB" || v === "MESSAGE" || v === "USER_TASK" || v === "TIMER" || v === "SIGNAL" || v === "CONDITION"
    ? v
    : undefined;
}

/** Narrow an argument to a real engine incident state — the `"UNKNOWN"` client-side sentinel is
 *  deliberately NOT a selector (see `IncidentState`/`IncidentFilter`), so it is rejected here. */
function readIncidentState(args: Record<string, unknown>, key: string): EngineIncidentState | undefined {
  const v = args[key];
  return v === "ACTIVE" || v === "MIGRATED" || v === "PENDING" || v === "RESOLVED" ? v : undefined;
}

/** Read a plain JSON object argument (an MCP `object` input), else `undefined`. Used for the
 *  `set_variables` payload — an arbitrary variable map handed to the engine verbatim. */
function readObject(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  return isRecord(v) ? v : undefined;
}

/** Read a finite integer argument (for a job's retry count), else `undefined`. */
function readInteger(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** One framework-owned debug tool: its MCP descriptor plus a handler that reads engine truth / a
 *  projection store, or (for a `mutating` tool) performs an unstick operation. A `mutating` tool is
 *  gated by the shared-secret guard before its handler runs (ADR 0067 §4); a read tool is not. */
interface DebugTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Whether the tool mutates engine state — gates it behind the shared-secret guard and flips the
   *  `readOnlyHint` annotation off in `tools/list`. Read tools omit it (default read-only). */
  readonly mutating?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const OPTIONAL_STRING = { type: "string" } as const;

/** Build the framework debug tools, closing over the app's engine (truth plane) and default data
 *  source (the ADR 0065 projection stores). READ tools consume the engine's read accessors and the
 *  projection stores; MUTATING tools (ADR 0067 Slice 3, gated by the shared-secret guard) drive the
 *  Slice 2 seam extension — cancel an instance, resolve/retry an incident, set variables. */
function buildDebugTools(app: AppApi): DebugTool[] {
  const projectionDb = (): SqliteDb | undefined =>
    app.data.hasDefaultSource() ? app.data.source().db : undefined;

  return [
    {
      name: `${DEBUG_PREFIX}search_process_instances`,
      description: "Engine truth: search process instances by key and/or lifecycle state.",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKeys: { type: "array", items: OPTIONAL_STRING },
          state: { type: "string", enum: ["ACTIVE", "COMPLETED", "TERMINATED"] },
        },
      },
      run: (args) => {
        const filter: { processInstanceKeys?: string[]; state?: ProcessInstanceState } = {};
        const keys = readStringArray(args, "processInstanceKeys");
        if (keys) filter.processInstanceKeys = keys;
        const state = readProcessInstanceState(args, "state");
        if (state) filter.state = state;
        return app.engine.searchProcessInstances(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}search_element_instance_wait_states`,
      description: "Engine truth: search element-instance wait states (every park, not only user tasks).",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKey: OPTIONAL_STRING,
          elementId: OPTIONAL_STRING,
          waitStateType: {
            type: "string",
            enum: ["JOB", "MESSAGE", "USER_TASK", "TIMER", "SIGNAL", "CONDITION"],
          },
        },
      },
      run: (args) => {
        const filter: ElementInstanceWaitStateFilter = {};
        const pik = readPresentString(args, "processInstanceKey");
        if (pik) filter.processInstanceKey = pik;
        const elementId = readPresentString(args, "elementId");
        if (elementId) filter.elementId = elementId;
        const waitStateType = readWaitStateType(args, "waitStateType");
        if (waitStateType) filter.waitStateType = waitStateType;
        return app.engine.searchElementInstanceWaitStates(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}get_element_instance`,
      description: "Engine truth: fetch a single element instance by key (null when absent).",
      inputSchema: {
        type: "object",
        properties: { elementInstanceKey: OPTIONAL_STRING },
        required: ["elementInstanceKey"],
      },
      run: (args) => app.engine.getElementInstance(requireString(args, "elementInstanceKey")),
    },
    {
      name: `${DEBUG_PREFIX}search_user_tasks`,
      description: "Engine truth: search user tasks by process instance, assignee, candidate group, and/or state.",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKey: OPTIONAL_STRING,
          assignee: OPTIONAL_STRING,
          candidateGroup: OPTIONAL_STRING,
          state: { type: "string", enum: ["CREATED", "COMPLETED", "CANCELED", "FAILED"] },
        },
      },
      run: (args) => {
        const filter: UserTaskFilter & { state?: UserTaskState } = {};
        const pik = readPresentString(args, "processInstanceKey");
        if (pik) filter.processInstanceKey = pik;
        const assignee = readPresentString(args, "assignee");
        if (assignee) filter.assignee = assignee;
        const candidateGroup = readPresentString(args, "candidateGroup");
        if (candidateGroup) filter.candidateGroup = candidateGroup;
        const state = readUserTaskState(args, "state");
        if (state) filter.state = state;
        return app.engine.searchUserTasks(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}search_incidents`,
      description:
        "Engine truth: search incidents (stuck tokens — a job out of retries, an unhandled error, a failed gateway) by process instance and/or state. Read-only; each result carries the incidentKey/jobKey the mutating unstick tools take.",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKey: OPTIONAL_STRING,
          state: { type: "string", enum: ["ACTIVE", "MIGRATED", "PENDING", "RESOLVED"] },
        },
      },
      run: (args) => {
        const filter: IncidentFilter = {};
        const pik = readPresentString(args, "processInstanceKey");
        if (pik) filter.processInstanceKey = pik;
        const state = readIncidentState(args, "state");
        if (state) filter.state = state;
        return app.engine.searchIncidents(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}cancel_instance`,
      description: "MUTATING: cancel a running process instance. Requires the shared-secret guard.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: { processInstanceKey: OPTIONAL_STRING },
        required: ["processInstanceKey"],
      },
      run: async (args) => {
        const processInstanceKey = requireString(args, "processInstanceKey");
        await app.engine.cancelInstance({ processInstanceKey });
        return { cancelled: processInstanceKey };
      },
    },
    {
      name: `${DEBUG_PREFIX}resolve_incident`,
      description:
        "MUTATING: resolve an open incident by key, unblocking the parked token (bump the job's retries first for a jobNoRetries incident — see retry_job). Requires the shared-secret guard.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: { incidentKey: OPTIONAL_STRING },
        required: ["incidentKey"],
      },
      run: async (args) => {
        const incidentKey = requireString(args, "incidentKey");
        await app.engine.resolveIncident({ incidentKey });
        return { resolved: incidentKey };
      },
    },
    {
      name: `${DEBUG_PREFIX}retry_job`,
      description:
        "MUTATING: set a failed job's remaining retries (making it activatable again — the 'retry' half of unsticking a jobNoRetries incident). Requires the shared-secret guard.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: { jobKey: OPTIONAL_STRING, retries: { type: "integer", minimum: 0 } },
        required: ["jobKey", "retries"],
      },
      run: async (args) => {
        const jobKey = requireString(args, "jobKey");
        const retries = readInteger(args, "retries");
        if (retries === undefined || retries < 0)
          throw new McpError(ErrorCode.InvalidParams, "retries must be a non-negative integer");
        await app.engine.updateJobRetries({ jobKey, retries });
        return { jobKey, retries };
      },
    },
    {
      name: `${DEBUG_PREFIX}set_variables`,
      description:
        "MUTATING: merge variables into a scope (a process-instance or element-instance key); set `local` true to keep them in that local scope. Repairs state before resolving an incident. Requires the shared-secret guard.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          scopeKey: OPTIONAL_STRING,
          variables: { type: "object" },
          local: { type: "boolean" },
        },
        required: ["scopeKey", "variables"],
      },
      run: async (args) => {
        const scopeKey = requireString(args, "scopeKey");
        const variables = readObject(args, "variables");
        if (variables === undefined) throw new McpError(ErrorCode.InvalidParams, "variables must be an object");
        const input: { scopeKey: string; variables: Record<string, unknown>; local?: boolean } = {
          scopeKey,
          variables,
        };
        if (args.local === true) input.local = true;
        await app.engine.setVariables(input);
        return { scopeKey, set: Object.keys(variables) };
      },
    },
    {
      name: `${DEBUG_PREFIX}instance_state`,
      description: "Projection (urban_instance_state, ADR 0065): the canonical engine-lifecycle state for an instance.",
      inputSchema: {
        type: "object",
        properties: { processInstanceKey: OPTIONAL_STRING },
        required: ["processInstanceKey"],
      },
      run: (args) => {
        const key = requireString(args, "processInstanceKey");
        const db = projectionDb();
        if (!db) return Promise.resolve(null);
        return Promise.resolve(new InstanceStateStore(db).getState(key) ?? null);
      },
    },
    {
      name: `${DEBUG_PREFIX}open_user_tasks`,
      description: "Projection (urban_open_user_tasks, ADR 0065): the currently-open user tasks for an instance.",
      inputSchema: {
        type: "object",
        properties: { processInstanceKey: OPTIONAL_STRING },
        required: ["processInstanceKey"],
      },
      run: (args) => {
        const key = requireString(args, "processInstanceKey");
        const db = projectionDb();
        if (!db) return Promise.resolve([]);
        return Promise.resolve(new OpenUserTasksStore(db).openTasks(key));
      },
    },
  ];
}

/**
 * Mount the runtime-served MCP surface at `/app/mcp` (ADR 0067). Returns a single `*`-method route
 * (mounted unconditionally, like `/app/agent`); the handler bridges the host request/response seam
 * to the SDK's Web-Standard Streamable-HTTP transport, maintaining one MCP session per
 * `mcp-session-id`. The tool projection reuses the SAME OpenAPI enumeration and dispatch path as
 * `mountApi`, so a tool call is equivalent to the corresponding HTTP call.
 */
export function mountMcp(ctx: RuntimeContext, app: AppApi, apiRoutes: Route[]): McpHandle {
  const config = readMcpConfig(ctx.manifest, ctx.host.env);
  // The effective HTTP bind interface. When the app is bound to all interfaces, the
  // client-controlled `Host` header is not a trustworthy loopback signal (a remote caller can send
  // `Host: localhost`), so a loopback-only surface must refuse EVERY caller rather than trust it.
  const bindMode = resolveBindMode(ctx.manifest, ctx.host.env);

  // Reuse the app's OpenAPI dispatch VERBATIM: `mountSurfaces` already built the `/app/api` router
  // (validation + delegate registry) via `mountApi` and hands us its routes here, so tool and HTTP
  // calls share ONE dispatcher instance (no forked dispatcher, no second doc/delegate cache). A tool
  // call is reconstructed into the operation's HTTP request and routed through this same router.
  const apiRouter = makeRouter(apiRoutes);

  // The parsed OpenAPI document, loaded lazily from the same spec `mountApi` reads and cached
  // (mirroring `mountApi`'s lazy `loadDoc`). Shared by the tool projection AND the mutation guard's
  // shared-secret-scheme resolution, so both read one parse of one spec. The absent-`doc` outcome is
  // discriminated: `failed: false` is a legitimately-absent binding (no app tools, no shared-secret
  // scheme); `failed: true` is a broken/unparseable spec (a server misconfiguration, already logged)
  // — the mutation guard needs the distinction to answer a `401` (nothing to authorize against) vs a
  // `500` (spec broken, can't even tell) rather than conflating both as unauthorized. A failure is
  // not cached, so a later request retries.
  type SpecLoad = { doc: OpenApiDoc } | { doc: undefined; failed: boolean };
  let docPromise: Promise<SpecLoad> | undefined;
  const loadSpecDoc = (): Promise<SpecLoad> => {
    if (!docPromise) {
      docPromise = (async (): Promise<SpecLoad> => {
        const binding = readApiBinding(ctx.manifest);
        if (!binding) return { doc: undefined, failed: false };
        const text = await ctx.host.readTextFile(resolveAppPath(ctx.root, binding.spec));
        return { doc: parseSpec(text) };
      })().catch((e) => {
        docPromise = undefined; // don't cache the failure — let a later request retry
        ctx.host.log("warn", "mcp: failed to load the app OpenAPI spec", { error: errorMessage(e) });
        return { doc: undefined, failed: true };
      });
    }
    return docPromise;
  };

  // The projected app operation table (read AND mutating), derived from the same enumeration
  // `mountApi` routes. `x-mcp`-excluded operations are dropped (the security-relevant opt-out) as
  // are reserved-namespace ids; the read/mutate split is applied at annotation + guard time via
  // `isMutatingOperation`, never a forked walker. Memoized PER parsed spec document (keyed on the
  // cached doc promise `loadSpecDoc` returns): `tools/list` and `tools/call` both hit this on every
  // request, so recomputing `collectOperations` + the reserved-namespace filter (and re-emitting its
  // warn) each time is avoidable overhead and log spam. When the spec fails to load `loadSpecDoc`
  // resets its promise, so the key changes and the projection is recomputed on the retry.
  let projectedOps: { docKey: Promise<SpecLoad>; ops: Promise<OperationInfo[]> } | undefined;
  const loadProjectedOps = (): Promise<OperationInfo[]> => {
    const docKey = loadSpecDoc();
    if (projectedOps?.docKey !== docKey) {
      const ops = docKey.then(({ doc }) => {
        if (!doc) return [];
        const projected = collectOperations(doc).filter((op) => !op.mcpExcluded);
        // The `urban_debug_` namespace is framework-reserved (see DEBUG_PREFIX). A `urban_debug_*`
        // operationId is a legal safe path segment, so an app could declare one — but `CallTool`
        // resolves `debugByName` before app ops, so such an op would be shadowed by the framework
        // tool AND surface a duplicate name in `tools/list`. Drop reserved-namespace app ops here
        // (the single projection source both `tools/list` and `CallTool` read), warning per drop,
        // so the collision is impossible by construction rather than order-dependent.
        return projected.filter((op) => {
          if (op.operationId.startsWith(DEBUG_PREFIX)) {
            ctx.host.log("warn", "mcp: dropped app operation using reserved framework tool namespace", {
              operationId: op.operationId,
              reservedPrefix: DEBUG_PREFIX,
            });
            return false;
          }
          return true;
        });
      });
      projectedOps = { docKey, ops };
    }
    return projectedOps.ops;
  };

  const debugTools = buildDebugTools(app);
  const debugByName = new Map(debugTools.map((t) => [t.name, t]));

  // A minimal `OperationInfo` that requires ONLY the app's shared-secret scheme, so the framework
  // mutating tools reuse `evaluateSecurity` VERBATIM (constant-time compare, misconfig→500, absent
  // credential→401) rather than a bespoke comparison — the same enforcement path an app operation's
  // own `security` takes. It is never routed; only its `security` field is read.
  const sharedSecretOp = (schemeName: string): OperationInfo => ({
    operationId: "__mcp_mutation_guard__",
    method: "post",
    path: "/__mcp_mutation_guard__",
    parameters: [],
    requestBodyRequired: false,
    responseSchemas: [],
    security: [{ [schemeName]: [] }],
    eject: false,
    mcpExcluded: false,
  });

  // Decide whether a mutating tool call is authorized. Either an explicit runtime opt-in
  // (`mcp.allowMutations` / `URBAN_MCP_ALLOW_MUTATIONS`) opens mutations credential-free — but only
  // LOOPBACK-ONLY (`!allowRemote`), so exposing the surface to non-loopback callers can never
  // silently drop the guard — OR the client presented the app's shared secret (the apiKey header
  // scheme, via `x-nano-secret-env`). With no shared-secret scheme configured and no (in-scope)
  // opt-in, mutations are refused (fail closed).
  const NO_SHARED_SECRET_SCHEME_ERROR =
    "mutating MCP tools require the app's shared secret (an apiKey header security scheme with x-nano-secret-env), or the explicit mcp.allowMutations opt-in (honoured loopback-only, i.e. when mcp.allowRemote is off)";
  const authorizeMutation = async (
    headers: Record<string, string | string[] | undefined>,
  ): Promise<SecurityDecision> => {
    // The credential-free opt-in is loopback-only: with `allowRemote` on, a non-loopback caller
    // could otherwise reach mutating `urban_debug_*` tools with no shared-secret guard at all, which
    // contradicts the "trusted, purely local box" intent. When remote exposure is enabled we ignore
    // the bypass and fall through to require the shared secret.
    if (config.allowMutations && !config.allowRemote) return { ok: true };
    const loaded = await loadSpecDoc();
    if (!loaded.doc && loaded.failed) {
      // A broken/unparseable spec is a server misconfiguration (500) — already logged by
      // `loadSpecDoc` — not a missing credential (401): with no parsed spec we cannot even tell
      // whether a shared-secret scheme exists to authorize against, so mirror `mountApi` and surface
      // a 500 (the CallTool handler logs it) rather than a misleading 401.
      return {
        ok: false,
        status: 500,
        error:
          "mutating MCP tools cannot be authorized: the app OpenAPI spec failed to load (server misconfiguration — see the logged 'mcp: failed to load the app OpenAPI spec' error)",
      };
    }
    // A misconfigured spec — more than one candidate shared-secret scheme, so which one guards
    // mutations would depend on authoring order — is a 500 (see `sharedSecretSchemeName`), not a
    // missing/bad credential. Surface it like the other misconfiguration branches above.
    let schemeName: string | undefined;
    try {
      schemeName = loaded.doc ? sharedSecretSchemeName(loaded.doc) : undefined;
    } catch (e) {
      return { ok: false, status: 500, error: errorMessage(e) };
    }
    if (!loaded.doc || !schemeName) {
      return { ok: false, status: 401, error: NO_SHARED_SECRET_SCHEME_ERROR };
    }
    return evaluateSecurity(
      loaded.doc,
      sharedSecretOp(schemeName),
      (name) => readHeader(headers, name),
      () => undefined,
      (envVar) => ctx.host.env(envVar),
    );
  };

  const dispatchOperationTool = async (
    op: OperationInfo,
    args: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> => {
    const missing = missingPathParams(op, args);
    if (missing.length > 0) {
      // Surface as an error tool result (like a reused-validator failure), not a silent 404 from an
      // empty-string substitution — the calling agent sees exactly which required params it omitted.
      return textResult(
        { error: `validation failed: missing required path parameter(s): ${missing.join(", ")}` },
        true,
      );
    }
    // Faithful body transport (ADR 0067): a client may send an object/array `body` pre-encoded as a
    // JSON string. Normalize it to the structured value from the operation's RESOLVED body schema so
    // it is not double-encoded by `toHttpRequest`; a string that cannot parse to the declared shape
    // is a clear tool error rather than a silent 4xx from a double-encoded body.
    const normalized = normalizeBodyArg(op, args, (await loadSpecDoc()).doc);
    if (!normalized.ok) return textResult({ error: normalized.error }, true);
    // Forward the MCP connection's headers so the reused router enforces the operation's own
    // OpenAPI `security` (a mutating — or secured read — app op is guarded exactly as its HTTP
    // route). A `401`/`403`/`500` from that enforcement flows back as an error tool result.
    const res = await apiRouter(toHttpRequest(op, normalized.args, headers));
    const status = res.status ?? 200;
    return textResult(res.body ?? "", status >= 400);
  };

  const readSystemBrief = async (): Promise<string> => {
    const path = resolveAppPath(ctx.root, `${GENERATED_DIR}/${SYSTEM_BRIEF_JSON}`);
    if (!(await ctx.host.exists(path))) {
      throw new McpError(ErrorCode.InvalidParams, "system brief not generated — run `urban gen`");
    }
    return ctx.host.readTextFile(path);
  };

  const orientationText = (): string =>
    [
      `# ${ctx.manifest.name ?? "Urban app"} — MCP orientation`,
      "",
      "This endpoint is the app's runtime-served MCP surface (ADR 0067).",
      "",
      `- Read the \`${SYSTEM_BRIEF_URI}\` resource first for the app's system model (processes, service-task call graph, decisions, ownership).`,
      "- App tools mirror the app's HTTP operations one-to-one: a tool call is equivalent to the corresponding `/app/api` HTTP call, validated identically and authorized exactly as that HTTP route by the operation's own OpenAPI `security` (an operation with no `security` is open — there is no extra MCP-level guard). An operation is exposed unless it opts out with the `x-mcp` extension (a security-relevant authoring switch).",
      `- \`${DEBUG_PREFIX}*\` READ tools are framework-owned process-debugging tools: engine truth (process instances, wait states, element instances, user tasks, incidents) and the ADR 0065 projection stores (instance state, open user tasks). They are unauthenticated on loopback.`,
      `- \`${DEBUG_PREFIX}*\` MUTATING tools (cancel_instance, resolve_incident, retry_job, set_variables) are framework-GUARDED: present the app's shared secret as its apiKey header on the MCP connection, or the operator must set the mcp.allowMutations opt-in (honoured loopback-only — when mcp.allowRemote is enabled, mutations always require the shared secret). A mutating call without the credential is refused. (App operation tools are NOT covered by this guard — they are authorized by their own OpenAPI \`security\`, above.)`,
    ].join("\n");

  /** Build a fresh low-level MCP `Server` with this app's tools/resources/prompts wired. One is
   *  created per session and connected to that session's transport. */
  const buildServer = (): Server => {
    const server = new Server(
      { name: "urban", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const ops = await loadProjectedOps();
      const appTools = ops.map((op) => {
        const mutating = isMutatingOperation(op);
        return {
          name: op.operationId,
          description: op.summary ?? `${op.method.toUpperCase()} ${op.path}`,
          inputSchema: toolInputSchema(op),
          annotations: { readOnlyHint: !mutating, destructiveHint: mutating },
        };
      });
      const frameworkTools = debugTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: !t.mutating, destructiveHint: t.mutating === true },
      }));
      return { tools: [...appTools, ...frameworkTools] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      // The client presents its shared-secret credential as a header on the MCP connection; the SDK
      // surfaces the request's headers here via `requestInfo`. Empty when a host cannot supply them
      // (then a mutating call falls back to refuse unless the runtime opt-in is set).
      const headers = extra.requestInfo?.headers ?? {};
      const debug = debugByName.get(name);
      if (debug) {
        if (debug.mutating) {
          const authz = await authorizeMutation(headers);
          if (!authz.ok) {
            const status = authz.status ?? 401;
            // Mirror `mountApi`'s security handling: a `500` refusal means the shared-secret scheme
            // is misconfigured (unknown/unsupported scheme, or an unset secret env var) rather than a
            // bad/absent credential. Log it — as `mountApi` does for its OpenAPI security — so an
            // operator can diagnose the misconfiguration, and carry the status in the error payload
            // so a client can distinguish a `500` misconfig from a `401` unauthorized.
            if (status === 500) {
              ctx.host.log("error", "mcp mutating tool security is misconfigured (ADR 0059)", {
                tool: name,
                reason: authz.error,
              });
            }
            return textResult({ error: authz.error ?? "unauthorized", status }, true);
          }
        }
        const missing = missingRequiredArgs(debug.inputSchema, args);
        if (missing.length > 0) {
          // Fail fast like an operation-tool validation error, instead of substituting an empty
          // string that makes an invalid call look like a legitimate "not found" result.
          return textResult(
            { error: `validation failed: missing required parameter(s): ${missing.join(", ")}` },
            true,
          );
        }
        try {
          return textResult(await debug.run(args));
        } catch (e) {
          return textResult({ error: errorMessage(e) }, true);
        }
      }
      const ops = await loadProjectedOps();
      const op = ops.find((o) => o.operationId === name);
      if (!op) {
        throw new McpError(ErrorCode.MethodNotFound, `no such tool: ${name}`);
      }
      // App operation tools inherit their OpenAPI `security` — the forwarded headers let the reused
      // router enforce it, so a mutating (or secured read) app op is guarded exactly as its HTTP route.
      return dispatchOperationTool(op, args, headers);
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: SYSTEM_BRIEF_URI,
          name: "system-brief",
          title: "App system brief",
          description: "The app's derived institutional-memory brief (the /app/agent.json content).",
          mimeType: "application/json",
        },
      ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (uri !== SYSTEM_BRIEF_URI) {
        throw new McpError(ErrorCode.InvalidParams, `no such resource: ${uri}`);
      }
      const text = await readSystemBrief();
      return { contents: [{ uri, mimeType: "application/json", text }] };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: ORIENTATION_PROMPT,
          title: "Orient on this app",
          description: "How to use this app's MCP surface: its read tools, debug tools, and system-brief resource.",
          arguments: [],
        },
      ],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name !== ORIENTATION_PROMPT) {
        throw new McpError(ErrorCode.InvalidParams, `no such prompt: ${request.params.name}`);
      }
      return {
        description: "Orientation for working against this app over MCP.",
        messages: [{ role: "user", content: { type: "text", text: orientationText() } }],
      };
    });

    return server;
  };

  interface Session {
    readonly server: Server;
    readonly transport: WebStandardStreamableHTTPServerTransport;
  }
  const sessions = new Map<string, Session>();

  const createSession = async (): Promise<Session> => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId(),
      enableJsonResponse: true,
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
    return { server, transport };
  };

  /** Convert the host request into the Web-Standard `Request` the SDK transport consumes. The body
   *  is passed separately (as `parsedBody`) so the transport never re-reads it; the Request carries
   *  the method + headers (Accept, content-type, `mcp-session-id`, protocol version) it inspects. */
  const toWebRequest = (req: HttpRequest): Request => {
    const search = req.query.toString();
    const url = `http://localhost${req.path}${search ? `?${search}` : ""}`;
    const headers = new Headers();
    for (const [key, value] of req.headers) headers.set(key, value);
    return new Request(url, { method: req.method, headers });
  };

  const toHttpResponse = async (res: Response): Promise<HttpResponse> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of res.headers) headers[key] = value;
    return { status: res.status, headers, body: await res.text() };
  };

  const methodNotAllowed = (): HttpResponse => ({
    status: 405,
    headers: { allow: "POST, DELETE", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: the MCP endpoint accepts POST (and DELETE to end a session)." },
      id: null,
    }),
  });

  const handle = async (req: HttpRequest): Promise<HttpResponse> => {
    if (!config.enabled) return json({ error: "MCP surface is disabled" }, 404);
    if (!config.allowRemote) {
      // Bound to all interfaces, `Host` can't be trusted as a loopback proof: refuse everyone
      // unless remote access is explicitly opted in (mcp.allowRemote / URBAN_MCP_ALLOW_REMOTE).
      if (bindMode === "all") {
        return json(
          { error: "MCP surface is loopback-only, but the app is bound to all interfaces; set mcp.allowRemote to expose it" },
          403,
        );
      }
      if (!isLoopbackRequest(req)) {
        return json({ error: "MCP surface is loopback-only" }, 403);
      }
    }
    const method = req.method.toUpperCase();
    // The string-body host seam cannot hold open an SSE stream, so the optional GET server→client
    // stream is declined with 405 (spec-compliant): clients fall back to POST request/response.
    if (method !== "POST" && method !== "DELETE") return methodNotAllowed();

    const rawBody = method === "POST" ? await req.text() : "";
    let parsedBody: unknown;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return json(
          { jsonrpc: "2.0", error: { code: ErrorCode.ParseError, message: "request body is not valid JSON" }, id: null },
          400,
        );
      }
    }

    const sessionId = req.headers.get(SESSION_HEADER) ?? undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    // Refresh an existing session's recency so an actively-used session is never the LRU victim.
    if (session && sessionId) touchSession(sessions, sessionId, session);
    if (!session) {
      const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      if (!messages.some((m) => isInitializeRequest(m))) {
        return json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session id, and not an initialize request." },
            id: null,
          },
          400,
        );
      }
      session = await createSession();
    }

    const webResponse = await session.transport.handleRequest(toWebRequest(req), { parsedBody });
    // A newly-initialized session assigns its id during handleRequest — register it so the client's
    // follow-up requests (carrying `mcp-session-id`) resolve back to this same server/transport.
    const assignedId = session.transport.sessionId;
    if (assignedId && !sessions.has(assignedId)) {
      sessions.set(assignedId, session);
      // Enforce the hard cap once the freshly-initialized session is registered, evicting the
      // least-recently-used pairs (never this one — it is now the newest) so the map stays bounded.
      await evictExcessSessions(sessions, MAX_SESSIONS, (s) => s.server.close());
    }
    return toHttpResponse(webResponse);
  };

  const routes: Route[] = [
    { method: "*", path: MCP_PATH, source: "surface:mcp", handler: handle },
  ];
  ctx.host.log("info", "mcp surface mounted", {
    path: MCP_PATH,
    enabled: config.enabled,
    loopbackOnly: !config.allowRemote,
  });
  return {
    name: "mcp",
    routes,
    enabled: config.enabled,
    describe: () => ({
      mcp: {
        path: MCP_PATH,
        enabled: config.enabled,
        loopbackOnly: !config.allowRemote,
        allowMutations: config.allowMutations,
      },
    }),
  };
}
