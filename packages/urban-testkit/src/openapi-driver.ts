// A self-contained, spec-driven HTTP operations driver for the e2e harness (issue #157, S3).
//
// The driver reads the *booted app's own* OpenAPI document, enumerates its operations, and lets a
// test call them by `operationId` — the same stable identity the runtime dispatches on
// (`<dir>/<operationId>`) and the ADR-0059 "one HTTP surface" treats as the source of truth. A test
// never hard-codes a route path or method: those are derived from the spec, so the driver can never
// drift from the surface it drives (AGENTS.md "Derivation Over Duplication").
//
// Like `wasm-engine.ts`, this module is deliberately *self-contained*: it does NOT import urban's
// `parseSpec`/`collectOperations`. The testkit and `@nanobpm/urban` both resolve to the app-under-
// test's own `node_modules` in an e2e (an app can be on an older urban than the testkit's peer
// floor), so importing a runtime-internal export would couple the driver to a specific urban
// version. A tiny standalone OpenAPI enumerator is trivial and version-robust, and mirrors exactly
// how the runtime mounts operations (fixed `/app/api` base + the operation's path template).

import { parse as parseYaml } from "yaml";
import type { HttpResponse } from "@nanobpm/urban/runtime";

/** The fixed operation base the runtime mounts every operation under (urban `api.ts` `API_BASE`).
 *  A constant there, so a constant here — the two are the single contract this driver relies on. */
const API_BASE = "/app/api";

/** OpenAPI HTTP method keys, lower-cased as they appear on a Path Item Object. */
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One enumerated operation: its id, HTTP method, and OpenAPI path template.
 *  `pathParams` are the `{name}` placeholders in the template — the names a caller MUST supply. */
export interface ApiOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** The OpenAPI path template, e.g. "/invoices/{id}" (WITHOUT the `/app/api` base). */
  readonly path: string;
  /** Placeholder names in `path`, e.g. ["id"] for "/invoices/{id}". */
  readonly pathParams: readonly string[];
}

/**
 * Parse an OpenAPI document from text. JSON is tried first (fast path + precise errors; also covers
 * a generated `openapi.json`), then YAML (which subsumes JSON, so authored `.yaml`/`.yml` load).
 * Mirrors urban's own `parseSpec` so a spec that loads in production loads here too — including its
 * root-shape guard: a non-object root (e.g. `42`, `[]`, `null`) is rejected, so a malformed spec
 * fails fast here exactly as the runtime rejects it ("spec must be an object"), rather than silently
 * enumerating zero operations and surfacing later as a confusing "unknown operationId".
 */
export function parseOpenApi(text: string): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (jsonError) {
    try {
      doc = parseYaml(text);
    } catch (yamlError) {
      const jsonMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
      const yamlMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
      throw new Error(
        `testkit: OpenAPI spec is not valid JSON or YAML: JSON parse error: ${jsonMessage}; ` +
          `YAML parse error: ${yamlMessage}`,
      );
    }
  }
  if (!isRecord(doc)) {
    throw new Error("testkit: OpenAPI spec must be an object (a mapping at the document root)");
  }
  return doc;
}

/** An operationId names the delegate module file (`<dir>/<operationId>`), so the runtime only mounts
 *  it when it is a single safe path segment — separators (`/`, `\`) and parent-dir traversal (`..`,
 *  `.`) are rejected so a crafted spec can't import a file outside the operations directory. Mirrors
 *  urban's `isSafeOperationId` (openapi/spec.ts) so the driver enumerates exactly the mounted surface
 *  and never lists/calls an operation the runtime would have skipped. Kept standalone for the same
 *  version-robustness reason the whole module is (see file header) rather than importing urban's. */
function isSafeOperationId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") && id !== ".";
}

/** Extract the `{name}` placeholders from a path template, in order of appearance. */
function templateParams(path: string): string[] {
  const names: string[] = [];
  const re = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null = re.exec(path);
  while (m !== null) {
    names.push(m[1]);
    m = re.exec(path);
  }
  return names;
}

/**
 * Enumerate the operations of an OpenAPI document exactly as the runtime does: walk `paths` → each
 * HTTP method → the operation's `operationId`. Operations without an `operationId` are skipped (the
 * runtime cannot dispatch them either), as are those whose `operationId` is not a safe path segment
 * (`isSafeOperationId`) — the runtime never mounts those, so listing them here would let a test call
 * an operation that does not exist. Paths are visited in sorted order for a stable enumeration.
 */
export function collectOperations(doc: unknown): ApiOperation[] {
  const out: ApiOperation[] = [];
  const paths = isRecord(doc) && isRecord(doc.paths) ? doc.paths : {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    const pathParams = templateParams(path);
    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!isRecord(opRaw)) continue;
      const operationId = typeof opRaw.operationId === "string" ? opRaw.operationId : undefined;
      if (!operationId || !isSafeOperationId(operationId)) continue;
      out.push({ operationId, method, path, pathParams });
    }
  }
  return out;
}

/** A route invocation against the in-process router — the low-level primitive the driver builds on. */
export interface DriverRouteRequest {
  method: string;
  path: string;
  query?: Record<string, string> | URLSearchParams;
  headers?: Record<string, string> | Headers;
  body?: string;
}

/** The response returned by {@link ApiDriver.call} and {@link ApiDriver.callRoute}. */
export interface ApiResponse<T = unknown> {
  /** HTTP status (defaults to 200 when the handler omitted it, matching the runtime). */
  readonly status: number;
  /** Response headers. */
  readonly headers: Headers;
  /** The raw response body text (empty string when the handler returned no body). */
  readonly text: string;
  /** The response body parsed as JSON when it is JSON (by `content-type` or a successful parse),
   *  otherwise the raw text. Typed as `T` for caller convenience; no runtime cast is performed. */
  readonly body: T;
}

/** Per-call inputs for {@link ApiDriver.call}. All are optional. */
export interface ApiCallOptions {
  /** Values for the operation's `{name}` path placeholders. Every placeholder must be supplied. */
  params?: Record<string, string | number | boolean>;
  /** Query-string parameters (appended to the URL). */
  query?: Record<string, string | number | boolean> | URLSearchParams;
  /** Request body — JSON-serialized, with `content-type: application/json` set automatically.
   *  Omit for a body-less request (e.g. a GET); pass a string via {@link ApiDriver.callRoute} for
   *  a non-JSON body. */
  body?: unknown;
  /** Extra request headers (merged over the automatic `content-type`). */
  headers?: Record<string, string> | Headers;
}

/** Drives a booted app's OpenAPI operations by `operationId`, plus raw routes via `callRoute`. */
export interface ApiDriver {
  /**
   * Call an operation by its `operationId`. Fills the path template from `params`, prefixes the
   * `/app/api` base, JSON-serializes `body`, and dispatches through the in-process router. Throws
   * on an unknown `operationId` or a missing required path parameter (a test bug, surfaced loudly).
   */
  call<T = unknown>(operationId: string, opts?: ApiCallOptions): Promise<ApiResponse<T>>;
  /**
   * Call a raw route (a page action, a hook, or any path not in the operation set) by method + path.
   * A thin, response-parsing wrapper over the low-level `ui.call`; the caller supplies the exact
   * path (no `/app/api` base is added).
   */
  callRoute<T = unknown>(req: DriverRouteRequest): Promise<ApiResponse<T>>;
  /** The `operationId`s this app exposes, in enumeration order (feeds a coverage gate later). */
  operationIds(): string[];
  /** Look up one enumerated operation by id (its method + path template), or undefined. */
  operation(operationId: string): ApiOperation | undefined;
}

function toQuery(query: ApiCallOptions["query"]): URLSearchParams {
  if (query instanceof URLSearchParams) return query;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) sp.set(k, String(v));
  return sp;
}

function mergeHeaders(base: Record<string, string>, extra: ApiCallOptions["headers"]): Headers {
  const h = new Headers(base);
  const extraHeaders = extra instanceof Headers ? extra : new Headers(extra ?? {});
  extraHeaders.forEach((value, key) => h.set(key, value));
  return h;
}

/** Fill a path template's `{name}` placeholders from `params`, throwing on any missing value. */
function fillPath(op: ApiOperation, params: Record<string, string | number | boolean>): string {
  return op.path.replace(/\{([^{}]+)\}/g, (_full, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new Error(
        `testkit api.call("${op.operationId}"): missing path parameter "${name}" ` +
          `(template ${op.path})`,
      );
    }
    return encodeURIComponent(String(params[name]));
  });
}

function isJsonContentType(headers: Headers): boolean {
  const ct = headers.get("content-type");
  return ct !== null && ct.toLowerCase().includes("json");
}

/** Build an {@link ApiResponse} from the router's raw {@link HttpResponse}, parsing a JSON body. */
function toApiResponse<T>(res: HttpResponse): ApiResponse<T> {
  const headers = new Headers(res.headers ?? {});
  const text = res.body ?? "";
  let body: unknown = text;
  if (text.length > 0) {
    if (isJsonContentType(headers)) {
      body = JSON.parse(text);
    } else {
      // No/other content-type: attempt JSON opportunistically (operations JSON-serialize by
      // default) but fall back to the raw text so a plain-text route still returns its body.
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  }
  // The response body is an untyped runtime boundary (whatever the handler JSON-serialized). The
  // generic `T` is an ergonomic annotation the test opts into; the driver performs NO runtime
  // validation of the shape — that is the test's own assertion. This is the one place a cast is
  // genuinely unavoidable, per the AGENTS.md untyped-boundary exception.
  // biome-ignore lint/plugin: HTTP response body is an untyped runtime boundary; T is a caller annotation, not a validated shape.
  return { status: res.status ?? 200, headers, text, body: body as T };
}

/**
 * Build an {@link ApiDriver} over an enumerated operation set and a low-level route caller (the
 * harness's `ui.call`). Self-contained: no urban runtime imports beyond the `HttpResponse` type.
 */
export function createApiDriver(
  operations: readonly ApiOperation[],
  uiCall: (req: DriverRouteRequest) => Promise<HttpResponse>,
): ApiDriver {
  const byId = new Map<string, ApiOperation>();
  for (const op of operations) byId.set(op.operationId, op);

  const callRoute = async <T,>(req: DriverRouteRequest): Promise<ApiResponse<T>> => {
    const res = await uiCall(req);
    return toApiResponse<T>(res);
  };

  return {
    callRoute,
    operationIds: () => operations.map((op) => op.operationId),
    operation: (operationId) => byId.get(operationId),
    call: async <T,>(operationId: string, opts: ApiCallOptions = {}): Promise<ApiResponse<T>> => {
      const op = byId.get(operationId);
      if (!op) {
        const known = operations.map((o) => o.operationId).sort().join(", ") || "(none)";
        throw new Error(
          `testkit api.call: unknown operationId "${operationId}". Known operations: ${known}`,
        );
      }
      const path = API_BASE + fillPath(op, opts.params ?? {});
      const hasBody = opts.body !== undefined;
      const headers = mergeHeaders(
        hasBody ? { "content-type": "application/json" } : {},
        opts.headers,
      );
      return callRoute<T>({
        method: op.method.toUpperCase(),
        path,
        query: toQuery(opts.query),
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
    },
  };
}
