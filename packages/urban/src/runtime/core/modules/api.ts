// api — the OpenAPI endpoint surface (ADR 0058). The contract-first counterpart to `actions[]`:
// instead of hand-rolled imperative handlers, an author declares `api: { spec }` in the manifest and
// writes one delegate module per `operationId`. This runtime reads the SAME OpenAPI document the
// toolkit deriver turns into types (via the shared `openapi/spec.ts`), mounts one dispatcher over the
// `api.base` namespace, and for each request: parses → validates params/query/body against the spec →
// 400 with a structured error → resolves + calls the operationId delegate (validated, typed input +
// the injected AppApi, exactly like a worker/action handler) → serializes the result.
//
// Coexistence + eject (ADR 0058): this mounts AFTER `mountActions` (so an exact `actions[]` route
// still shadows) and BEFORE the generic pages routes. Ejecting skips generated validation and hands
// the delegate the raw request — whole-surface via `api.eject`, or per-operation via the
// `x-urban-eject: true` OpenAPI vendor extension. The delegate is always additively imperative: it
// gets the raw `req` and full `AppApi` on top of the validated input.

import type { AppApi, RuntimeContext } from "../context.ts";
import { errorMessage } from "../guards.ts";
import type { HttpRequest, HttpResponse } from "../host.ts";
import { html, json, normalizeRoutePath, type Route } from "../router.ts";
import { resolveAppPath } from "./datasource.ts";
import {
  collectOperations,
  isSafeOperationId,
  type OpenApiDoc,
  type OpenApiSchema,
  type OperationInfo,
  operationsWithoutId,
  operationsWithUnsafeId,
  parseSpec,
  resolveSchema,
  toRouteMatcher,
  undeclaredPathParams,
  validateValue,
  type ValidationIssue,
} from "../../../openapi/spec.ts";

/** The manifest `api` binding (ADR 0058). Mirrored locally until `@nanobpm/nano-app-schema`
 *  republishes with the `api` field folded into `AppManifest` (the schema PR lands first). */
export interface ApiBinding {
  spec: string;
  dir?: string;
  base?: string;
  validateResponses?: "dev" | "always" | "never";
  eject?: boolean;
  /** Human API docs (Swagger UI). `true`/omitted → on at `${base}-docs` (ADR 0058); `false` →
   *  off; a string → a custom absolute route to mount the UI under. Spec-first apps get docs
   *  for free — the UI reads the SAME OpenAPI document the runtime routes + validates from. */
  docs?: boolean | string;
}

/** Pinned Swagger UI dist served from a CDN, so the docs UI adds zero bundle/runtime deps to an
 *  Urban app (matching the deps-free spirit of the rest of the surface — validators are standalone,
 *  ADR 0058 Consequences). Pinned (not `latest`) for reproducibility. */
const SWAGGER_UI_VERSION = "5.17.14";

/** Escape HTML-significant characters before embedding a value (the app name) in the docs markup. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** The self-contained Swagger UI page. Static HTML: it renders even when the spec is momentarily
 *  unreadable (Swagger UI fetches `specUrl` itself and surfaces any load/parse error in-page),
 *  which keeps the docs route decoupled from spec-load failures. */
function swaggerUiPage(title: string, specUrl: string): string {
  const css = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css`;
  const bundle = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${css}">
<style>body{margin:0}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${bundle}" crossorigin="anonymous"></script>
<script>
window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui', deepLinking: true });
</script>
</body>
</html>`;
}

/** The `{ params, query, body }` contract a typed operation is generic over. */
export interface OperationContract {
  params: unknown;
  query: unknown;
  body: unknown;
}

/** The loose contract an untyped delegate sees (strings on the wire; unknown JSON body). */
export interface DefaultContract {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** The input handed to an operation delegate: the raw request plus the parsed (and, unless ejected,
 *  validated) path params, query, and JSON body. */
export interface OperationInput<Req extends OperationContract = DefaultContract> {
  req: HttpRequest;
  params: Req["params"];
  query: Req["query"];
  body: Req["body"];
}

/** What a delegate returns; the runtime serializes `body` as JSON. Empty return → `204`. */
export interface OperationResult<Res = unknown> {
  status?: number;
  headers?: Record<string, string>;
  body?: Res;
}

/** An app-authored operation delegate: validated/typed input + the injected AppApi. */
export type OperationHandler<Req extends OperationContract = DefaultContract, Res = unknown> = (
  input: OperationInput<Req>,
  app: AppApi,
) => Promise<OperationResult<Res> | void> | OperationResult<Res> | void;

/**
 * Typed-identity helper the generated `operations.ts` wrapper re-types per operationId. Authoring:
 * `export default defineOperation("createInvoice", async ({ params, query, body }, app) => { ... })`
 * — the handler's first argument is the validated `OperationInput` (params/query/body/req), not the
 * raw request. The runtime resolves a delegate by its module path (`<dir>/<operationId>`), so the id
 * here is a documentation + typing aid; it is returned unchanged.
 */
export function defineOperation<Req extends OperationContract = DefaultContract, Res = unknown>(
  _id: string,
  handler: OperationHandler<Req, Res>,
): OperationHandler<Req, Res> {
  return handler;
}

function isFunction(v: unknown): v is OperationHandler {
  return typeof v === "function";
}

/** Resolve an operation delegate from a loaded module: `default` (when a function) else `handler`. */
export function resolveOperationHandler(mod: Record<string, unknown>): OperationHandler | undefined {
  if (isFunction(mod.default)) return mod.default;
  if (isFunction(mod.handler)) return mod.handler;
  return undefined;
}

function readApiBinding(manifest: unknown): ApiBinding | undefined {
  const raw = manifest && typeof manifest === "object" ? Reflect.get(manifest, "api") : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const spec = Reflect.get(raw, "spec");
  if (typeof spec !== "string" || spec.trim().length === 0) return undefined;
  const dir = Reflect.get(raw, "dir");
  const base = Reflect.get(raw, "base");
  const validateResponses = Reflect.get(raw, "validateResponses");
  const eject = Reflect.get(raw, "eject");
  const docs = Reflect.get(raw, "docs");
  // Trim benign manifest whitespace so it can't produce hard-to-diagnose path/import failures.
  return {
    spec: spec.trim(),
    dir: typeof dir === "string" && dir.trim().length > 0 ? dir.trim() : undefined,
    base: typeof base === "string" && base.trim().length > 0 ? base.trim() : undefined,
    validateResponses:
      validateResponses === "dev" || validateResponses === "always" || validateResponses === "never"
        ? validateResponses
        : undefined,
    eject: eject === true,
    // Docs default ON (spec-first apps get Swagger for free); `false` disables; a non-empty
    // string overrides the route. Anything else (including whitespace) falls back to the default.
    docs: docs === false ? false : typeof docs === "string" && docs.trim().length > 0 ? docs.trim() : true,
  };
}

/** Resolve the api `base` + docs routing from a binding, in ONE place, so `mountApi` (which
 *  serves the docs) and `apiDocsPath` (which the pages surface links to) can never drift. */
function resolveApiRoutes(binding: ApiBinding): {
  base: string;
  docsEnabled: boolean;
  docsBase: string;
} {
  const base = normalizeRoutePath(binding.base, "/app/api");
  const docsEnabled = binding.docs !== false;
  // Swagger UI at a SIBLING of the base (`${base}-docs`, e.g. /app/api-docs), never a subpath
  // of it — so the docs routes can't collide with, or be shadowed by, the operation dispatcher
  // that owns the `${base}/` prefix (a string `docs` overrides the whole route).
  const docsBase = normalizeRoutePath(
    typeof binding.docs === "string" ? binding.docs : `${base}-docs`,
    `${base}-docs`,
  );
  return { base, docsEnabled, docsBase };
}

/** The Swagger UI route for an app's `api` binding, or `undefined` when there is no api surface
 *  or docs are disabled. Lets other surfaces (e.g. the pages shell's "API docs" badge) link to
 *  the docs without re-deriving the path. */
export function apiDocsPath(manifest: unknown): string | undefined {
  const binding = readApiBinding(manifest);
  if (!binding) return undefined;
  const { docsEnabled, docsBase } = resolveApiRoutes(binding);
  return docsEnabled ? docsBase : undefined;
}

/** Coerce a wire string to the type its parameter schema declares, so numeric/boolean bounds
 *  validate. A value that will not coerce is left as-is and fails the type check with a clear
 *  message. The delegate still receives the original string(s). */
function coerceParam(doc: OpenApiDoc, schema: OpenApiSchema | undefined, raw: string): unknown {
  const s = resolveSchema(doc, schema);
  if (!s) return raw;
  if (s.type === "integer" || s.type === "number") {
    const n = Number(raw);
    return raw.trim() !== "" && !Number.isNaN(n) ? n : raw;
  }
  if (s.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return raw;
}

interface MountedOp {
  op: OperationInfo;
  pattern: RegExp;
  paramNames: string[];
}

export interface ApiHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

/**
 * Mount the OpenAPI endpoint surface. Returns no routes when the app declares no `api` binding, so
 * it is a no-op for apps that use only `actions[]`. A malformed spec (bad JSON / not an object)
 * mounts a single route under the base that returns a clear 500, rather than failing app boot.
 */
export function mountApi(ctx: RuntimeContext, app: AppApi): ApiHandle {
  const binding = readApiBinding(ctx.manifest);
  if (!binding) return { name: "api", routes: [], describe: () => ({ api: "disabled" }) };

  // Normalize the manifest base the same way actions[] routes do (shared normalizeRoutePath):
  // ensure a leading "/", strip trailing slashes, and fall back when empty — otherwise a base
  // like "app/api" would never match request paths, which always start with "/".
  //
  // The api `base` and the docs routing are derived TOGETHER by the shared helper (ADR 0058) so
  // this module (which serves the docs) and `apiDocsPath` (which links to them from the pages
  // shell) stay in lockstep with a single normalization of `binding.base` — no second, drifting
  // copy of that logic here. The spec JSON is served under the docs path so the operations
  // namespace stays purely operations.
  const { base, docsEnabled, docsBase } = resolveApiRoutes(binding);
  const dir = binding.dir ?? "operations";
  const surfaceEject = binding.eject === true;
  const specRoutePath = `${docsBase}/openapi.json`;

  // Resolve + parse the spec lazily on first request and cache it (mirroring the lazy module load
  // pattern). A malformed/unreadable spec surfaces as a 500 on request — with the reason — rather
  // than failing app boot.
  let docPromise: Promise<OpenApiDoc> | undefined;
  const loadDoc = (): Promise<OpenApiDoc> => {
    if (!docPromise) {
      docPromise = ctx.host
        .readTextFile(resolveAppPath(ctx.root, binding.spec))
        .then((text) => parseSpec(text))
        .catch((e) => {
          docPromise = undefined; // let a later request retry (e.g. after the file is fixed)
          throw new Error(`OpenAPI spec ${binding.spec} failed to load: ${errorMessage(e)}`);
        });
    }
    return docPromise;
  };

  // Lazily import + cache each delegate module, mirroring mountActions.
  const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
  const loadModule = (operationId: string): Promise<Record<string, unknown>> => {
    // Defense-in-depth at the import sink: collectOperations already skips unsafe ids, but never
    // build an import path from an operationId that isn't a single safe segment.
    if (!isSafeOperationId(operationId)) {
      return Promise.reject(new Error(`unsafe operationId (not a single path segment): ${operationId}`));
    }
    const key = resolveAppPath(ctx.root, `${dir.replace(/[/\\]+$/, "")}/${operationId}`);
    let pending = moduleCache.get(key);
    if (!pending) {
      pending = ctx.host.importModule(key).catch((err) => {
        moduleCache.delete(key);
        throw err;
      });
      moduleCache.set(key, pending);
    }
    return pending;
  };

  // Build the operation table lazily from the loaded doc (cached).
  let opsPromise: Promise<MountedOp[]> | undefined;
  const loadOps = (): Promise<MountedOp[]> => {
    if (!opsPromise) {
      opsPromise = loadDoc()
        .then((d) => {
          const missing = operationsWithoutId(d);
          if (missing.length > 0) {
            ctx.host.log("warn", "OpenAPI operations without operationId are skipped (ADR 0058)", {
              missing,
            });
          }
          const undeclared = undeclaredPathParams(d);
          if (undeclared.length > 0) {
            ctx.host.log(
              "warn",
              "OpenAPI path-template params are not declared as parameters — captured at runtime but neither typed nor validated (ADR 0058)",
              { undeclared },
            );
          }
          const unsafe = operationsWithUnsafeId(d);
          if (unsafe.length > 0) {
            ctx.host.log(
              "warn",
              "OpenAPI operationIds that are not a safe path segment are skipped (ADR 0058)",
              { unsafe },
            );
          }
          const mounted = collectOperations(d).map((op) => {
            const { pattern, paramNames } = toRouteMatcher(base, op.path);
            return { op, pattern, paramNames };
          });
          // Dispatch matches the first route in order, so sort most-specific first: fewer path-template
          // params (a static segment beats a `{param}` capture), then longer path. This keeps a static
          // route (e.g. /x/active) from being shadowed by a templated one (e.g. /x/{id}).
          mounted.sort((a, b) => {
            if (a.paramNames.length !== b.paramNames.length) {
              return a.paramNames.length - b.paramNames.length;
            }
            return b.op.path.length - a.op.path.length;
          });
          return mounted;
        })
        .catch((e) => {
          opsPromise = undefined; // don't cache the rejection — let a later request retry (mirrors loadDoc)
          throw e;
        });
    }
    return opsPromise;
  };

  const dispatchInner = async (req: HttpRequest): Promise<HttpResponse> => {
    let d: OpenApiDoc;
    let ops: MountedOp[];
    try {
      d = await loadDoc();
      ops = await loadOps();
    } catch (e) {
      return json({ error: errorMessage(e) }, 500);
    }

    const method = req.method.toUpperCase();
    const match = ops.find(
      (m) => m.op.method.toUpperCase() === method && m.pattern.test(req.path),
    );
    if (!match) {
      // Path is in our namespace but no operation matches: is it a known path on another method?
      const pathKnown = ops.some((m) => m.pattern.test(req.path));
      return json(
        { error: pathKnown ? "method not allowed" : "no such operation" },
        pathKnown ? 405 : 404,
      );
    }
    const { op } = match;
    const ejected = surfaceEject || op.eject;

    // Path params from the capture groups; query as a single-or-array map.
    const captures = match.pattern.exec(req.path) ?? [];
    const params: Record<string, string> = {};
    try {
      match.paramNames.forEach((name, i) => {
        const v = captures[i + 1];
        if (v !== undefined) params[name] = decodeURIComponent(v);
      });
    } catch {
      // Malformed percent-encoding is client input, not a server fault — a clear 400 beats a 500.
      return json({ error: "malformed path parameter encoding" }, 400);
    }
    const query: Record<string, string | string[] | undefined> = {};
    for (const key of new Set(req.query.keys())) {
      const all = req.query.getAll(key);
      query[key] = all.length > 1 ? all : all[0];
    }

    // Parse the JSON body (empty body → undefined). Invalid JSON is a 400 unless the op is ejected
    // (then the delegate reads the raw request itself).
    const raw = await req.text();
    let body: unknown = {};
    let bodyParseFailed = false;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        bodyParseFailed = true;
        body = undefined;
      }
    } else {
      body = undefined;
    }
    if (bodyParseFailed && !ejected) {
      return json({ error: "request body must be JSON" }, 400);
    }

    if (!ejected) {
      const issues: ValidationIssue[] = [];
      for (const p of op.parameters) {
        if (p.in === "path") {
          const val = params[p.name];
          if (val === undefined) {
            if (p.required) issues.push({ path: `params/${p.name}`, message: "is required" });
            continue;
          }
          issues.push(...validateValue(d, p.schema, coerceParam(d, p.schema, val), `params/${p.name}`));
        } else if (p.in === "query") {
          const val = query[p.name];
          if (val === undefined) {
            if (p.required) issues.push({ path: `query/${p.name}`, message: "is required" });
            continue;
          }
          const values = Array.isArray(val) ? val : [val];
          const ps = resolveSchema(d, p.schema);
          if (ps?.type === "array") {
            // Repeated keys (?tag=a&tag=b) form the array; coerce + validate each item, then the
            // whole array against the schema's array constraints (minItems, items, ...).
            const items = ps.items ? values.map((v) => coerceParam(d, ps.items, v)) : values;
            issues.push(...validateValue(d, ps, items, `query/${p.name}`));
          } else {
            // Scalar param: validate EVERY provided value, not just the first, so extra repeated
            // values can't bypass validation.
            values.forEach((v, i) => {
              const at = values.length > 1 ? `query/${p.name}[${i}]` : `query/${p.name}`;
              issues.push(...validateValue(d, p.schema, coerceParam(d, p.schema, v), at));
            });
          }
        }
      }
      if (op.requestBodyRequired && (raw === "" || body === undefined)) {
        issues.push({ path: "body", message: "request body is required" });
      } else if (op.requestBodySchema && body !== undefined) {
        issues.push(...validateValue(d, op.requestBodySchema, body, "body"));
      }
      if (issues.length > 0) {
        return json({ error: "request validation failed", issues }, 400);
      }
    }

    let handler: OperationHandler | undefined;
    try {
      handler = resolveOperationHandler(await loadModule(op.operationId));
    } catch (e) {
      ctx.host.log("error", "operation delegate failed to load", {
        operationId: op.operationId,
        dir,
        error: errorMessage(e),
      });
      return json({ error: `operation ${op.operationId} delegate failed to load` }, 500);
    }
    if (!handler) {
      return json(
        {
          error: `operation ${op.operationId} delegate exports no default function or named \`handler\``,
        },
        500,
      );
    }

    // Keep the runtime body in lockstep with the derived type: the deriver types `body` as
    // `undefined` exactly when the op declares no usable request body (no JSON schema and not
    // required), so pass `undefined` to those handlers rather than leaking a parsed value through
    // a body-less type.
    const handlerBody = op.requestBodySchema !== undefined || op.requestBodyRequired ? body : undefined;
    try {
      const result = await handler({ req, params, query, body: handlerBody }, app);
      if (!result) return { status: 204 };
      // Optional response validation (dev by default): warn-only, never blocks the response.
      const mode = binding.validateResponses ?? "dev";
      const doValidate =
        mode === "always" || (mode === "dev" && ctx.host.env("NODE_ENV") !== "production");
      if (doValidate && op.responseSchema && result.body !== undefined) {
        const rIssues = validateValue(d, op.responseSchema, result.body, "response");
        if (rIssues.length > 0) {
          ctx.host.log("warn", "operation response failed schema validation (ADR 0058)", {
            operationId: op.operationId,
            issues: rIssues,
          });
        }
      }
      return {
        status: result.status ?? 200,
        headers: { "content-type": "application/json", ...(result.headers ?? {}) },
        body: result.body === undefined ? undefined : JSON.stringify(result.body),
      };
    } catch (e) {
      return json({ error: errorMessage(e) }, 500);
    }
  };

  // Categorical safety net: any unexpected throw during dispatch — e.g. a malformed spec
  // `pattern` surfacing from validation — becomes a controlled 500 rather than escaping into
  // the host request handler, which has no top-level catch of its own.
  const dispatch = async (req: HttpRequest): Promise<HttpResponse> => {
    try {
      return await dispatchInner(req);
    } catch (e) {
      return json({ error: errorMessage(e) }, 500);
    }
  };

  // One prefix route over the base namespace does regex dispatch across all operations — the shared
  // router only does exact/prefix matches, so path-param templates are handled here. A trailing
  // slash keeps the prefix boundary-safe.
  const route: Route = {
    method: "*",
    path: `${base}/`,
    prefix: true,
    source: `api:${binding.spec}`,
    handler: dispatch,
  };
  // Also serve the base path exactly (an operation could live at the namespace root).
  const rootRoute: Route = {
    method: "*",
    path: base,
    prefix: false,
    source: `api:${binding.spec}`,
    handler: dispatch,
  };

  // Docs routes (ADR 0058): the Swagger UI page + the OpenAPI JSON it reads. Both are exact GET
  // routes on the `${base}-docs` sibling namespace, so they are wholly independent of the
  // operation dispatcher above.
  const serveSpec = async (): Promise<HttpResponse> => {
    let d: OpenApiDoc;
    try {
      d = await loadDoc();
    } catch (e) {
      return json({ error: errorMessage(e) }, 500);
    }
    // Point Swagger UI "Try it out" at the mounted namespace: operations live under `base`
    // (e.g. /app/api/invoices), not the spec's bare paths (/invoices). Overriding `servers`
    // makes the interactive console call the real Urban routes rather than the origin root.
    return json({ ...d, servers: [{ url: base }] });
  };
  const docsTitle = `${ctx.manifest.name ?? "App"} — API docs`;
  const serveDocs = (): HttpResponse => html(swaggerUiPage(docsTitle, specRoutePath));
  // A permanent redirect for the trailing-slash variant (`${docsBase}/`). The router only does
  // exact matches for non-prefix routes, so without this a reverse proxy or browser that appends
  // a slash would 404 on the Swagger UI. 308 preserves the method and points at the canonical
  // (slash-less) `docsBase` that `apiDocsPath` and every internal link already use.
  const redirectDocsSlash = (): HttpResponse => ({ status: 308, headers: { location: docsBase } });
  const docsRoutes: Route[] = docsEnabled
    ? [
        { method: "GET", path: docsBase, source: `api-docs:${binding.spec}`, handler: serveDocs },
        {
          method: "GET",
          path: `${docsBase}/`,
          source: `api-docs:${binding.spec}`,
          handler: redirectDocsSlash,
        },
        {
          method: "GET",
          path: specRoutePath,
          source: `api-docs:${binding.spec}`,
          handler: serveSpec,
        },
      ]
    : [];

  return {
    name: "api",
    routes: [...docsRoutes, rootRoute, route],
    describe: () => ({
      api: {
        spec: binding.spec,
        base,
        dir,
        eject: surfaceEject,
        docs: docsEnabled ? { ui: docsBase, spec: specRoutePath } : false,
      },
    }),
  };
}
