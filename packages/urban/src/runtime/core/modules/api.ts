// api — the OpenAPI endpoint surface (ADR 0058). The contract-first counterpart to `actions[]`:
// instead of hand-rolled imperative handlers, an author declares `api: { spec }` in the manifest and
// writes one delegate module per `operationId`. This runtime reads the SAME OpenAPI document the
// toolkit deriver turns into types (via the shared `openapi/spec.ts`), mounts one dispatcher over the
// fixed `/app/api` namespace, and for each request: parses → validates params/query/body against the spec →
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
import { MODULE_EXTENSION_CANDIDATES } from "../module-path.ts";
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
  responseSchemaForStatus,
  schemaHasType,
  schemaValueTypes,
  toRouteMatcher,
  undeclaredPathParams,
  undeclaredSecuritySchemes,
  evaluateSecurity,
  validateValue,
  type ValidationIssue,
} from "../../../openapi/spec.ts";

/** The manifest `api` binding (ADR 0058). Mirrored locally until `@nanobpm/nano-app-schema`
 *  republishes with the `api` field folded into `AppManifest` (the schema PR lands first). */
export interface ApiBinding {
  spec: string;
  dir?: string;
  validateResponses?: "dev" | "always" | "never";
  eject?: boolean;
  /** Human API docs (Swagger UI). `true`/omitted → on at `/app/api-docs` (ADR 0058); `false` →
   *  off; a string → a custom absolute route to mount the UI under. Spec-first apps get docs
   *  for free — the UI reads the SAME OpenAPI document the runtime routes + validates from. */
  docs?: boolean | string;
}

/** The canonical, non-configurable mount prefix for an app's OpenAPI operations. Operations always
 *  live under `/app/api` so page actions, links, and any `callRoute` can name an operation path as a
 *  stable framework constant (`/app/api/<op path>`) — there is no per-app `base` knob to drift. */
const API_BASE = "/app/api";

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

/**
 * Derive the ABSOLUTE spec + operations-server URLs the Swagger UI page should use, from the docs
 * page's own address (`pageHref`), the mount-root-relative docs path (`docsBase`, e.g.
 * `/app/api-docs`) and operations base (`apiBase`, e.g. `/app/api`).
 *
 * Why this can't be done server-side: the docs page can load at `<docsBase>` OR `<docsBase>/` (a
 * trailing slash — reverse proxies and some webviews append one), and behind the Nano console
 * proxy it carries a path prefix (`/console/app-view/<name>`). A document-relative spec URL or a
 * relative `servers` entry resolves DIFFERENTLY depending on that trailing slash — which sent
 * "Try it out" to `<mount>/app/api-docs/api/<op>` (a 404) instead of `<mount>/app/api/<op>`. The
 * app never sees the proxy prefix, so `window.location` in the browser is the only place with the
 * full mount path.
 *
 * We strip any trailing slash from the page path, then strip the known `docsBase` suffix to recover
 * the (proxy-prefixed) mount root, and re-append `docsBase`/`apiBase` as ORIGIN-absolute URLs — so
 * Swagger UI performs no further relative resolution and is immune to the trailing slash. When the
 * page path doesn't end in `docsBase` (unexpected) or the href is malformed, we fall back to the
 * document-relative `relSpec` and leave `servers` to the served spec (`server: null`).
 *
 * This runs in the browser: it is embedded verbatim into the docs page via `.toString()` so the
 * shipped page and these unit tests exercise the exact same code (no drift). Keep it dependency-free
 * and free of template literals / `${}` (it is interpolated into a template literal).
 */
export function deriveSwaggerUrls(
  pageHref: string,
  docsBase: string,
  apiBase: string,
  relSpec: string,
): { specUrl: string; server: string | null } {
  try {
    const loc = new URL(pageHref);
    const path = loc.pathname.replace(/\/+$/, "");
    if (path.length >= docsBase.length && path.slice(path.length - docsBase.length) === docsBase) {
      const mount = loc.origin + path.slice(0, path.length - docsBase.length);
      return { specUrl: mount + docsBase + "/openapi.json", server: mount + apiBase };
    }
  } catch {
    // Malformed href — fall through to the document-relative fallback below.
  }
  return { specUrl: relSpec, server: null };
}

/** The self-contained Swagger UI page. Static HTML: it renders even when the spec is momentarily
 *  unreadable (on a fetch/parse failure it hands `specUrl` to Swagger UI, which surfaces the error
 *  in-page), which keeps the docs route decoupled from spec-load failures. The client derives
 *  absolute spec + server URLs from `window.location` via `deriveSwaggerUrls` so "Try it out"
 *  targets the app regardless of a trailing slash on the docs URL or a reverse-proxy prefix. */
function swaggerUiPage(title: string, specUrl: string, docsBase: string, apiBase: string): string {
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
(function () {
  var derive = ${deriveSwaggerUrls.toString()};
  var urls = derive(window.location.href, ${JSON.stringify(docsBase)}, ${JSON.stringify(apiBase)}, ${JSON.stringify(specUrl)});
  function boot(opts) { window.ui = SwaggerUIBundle(opts); }
  fetch(urls.specUrl)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (spec) {
      if (spec && urls.server) { spec.servers = [{ url: urls.server }]; }
      boot(spec
        ? { spec: spec, dom_id: '#swagger-ui', deepLinking: true }
        : { url: urls.specUrl, dom_id: '#swagger-ui', deepLinking: true });
    })
    .catch(function () {
      boot({ url: urls.specUrl, dom_id: '#swagger-ui', deepLinking: true });
    });
})();
</script>
</body>
</html>`;
}

/** The `{ params, query, body }` contract a typed operation is generic over. `body` is optional so
 *  a generated request type for an operation without a required requestBody (its `body?` is
 *  optional/`undefined`) still satisfies the constraint — see the generated `operations.ts` /
 *  `controller.ts`, which parameterise `OperationHandler` over the per-op request type. */
export interface OperationContract {
  params: unknown;
  query: unknown;
  body?: unknown;
}

/** The loose contract an untyped delegate sees. Params/query values are `unknown` (coerced to their
 *  declared schema type before the delegate runs — the runtime validates then forwards the coerced
 *  value — but a schemaless/undeclared key, or any param of an ejected op, is forwarded raw, hence
 *  `unknown` rather than the coerced type); the JSON body is `unknown`. `body` is optional so a raw
 *  (untyped) delegate typed `OperationHandler<DefaultContract>` still satisfies the generated
 *  registry's per-operation `OperationHandler<ReqFor<K>>` slot — an op whose request body is
 *  optional/absent must be a subtype of the default contract (handler args are contravariant), and a
 *  schema-typed param object (e.g. `{ count: number }`) must be assignable to it. */
export interface DefaultContract {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: unknown;
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
 * Thrown by a write-once operation stub to signal the endpoint exists but has no implementation
 * yet; the dispatcher maps it to HTTP `501 Not Implemented` (ADR 0059). Delete the throw once you
 * implement the handler body. A brand property makes the check robust across module realms.
 */
export class NotImplemented extends Error {
  readonly urbanNotImplemented = true as const;
  constructor(operationId: string) {
    super(`operation not implemented: ${operationId}`);
    this.name = "NotImplemented";
  }
}

/** True for a `NotImplemented` throw (instanceof, or the brand — resilient to realm/dup-copy). */
function isNotImplemented(e: unknown): boolean {
  return (
    e instanceof NotImplemented ||
    (typeof e === "object" && e !== null && Reflect.get(e, "urbanNotImplemented") === true)
  );
}

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  const validateResponses = Reflect.get(raw, "validateResponses");
  const eject = Reflect.get(raw, "eject");
  const docs = Reflect.get(raw, "docs");
  // Trim benign manifest whitespace so it can't produce hard-to-diagnose path/import failures.
  return {
    spec: spec.trim(),
    dir: typeof dir === "string" && dir.trim().length > 0 ? dir.trim() : undefined,
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

/** Resolve the api `base` + docs routing, in ONE place, so `mountApi` (which serves the docs) and
 *  `apiDocsPath` (which the pages surface links to) can never drift. The operation base is the fixed
 *  `/app/api` constant; only the docs route remains manifest-configurable. */
function resolveApiRoutes(binding: ApiBinding): {
  base: string;
  docsEnabled: boolean;
  docsBase: string;
} {
  const base = API_BASE;
  const docsEnabled = binding.docs !== false;
  // Swagger UI at a SIBLING of the base (`/app/api-docs`), never a subpath of it — so the docs
  // routes can't collide with, or be shadowed by, the operation dispatcher that owns the
  // `${base}/` prefix (a string `docs` overrides the whole route).
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
 *  validate and the delegate receives the coerced value (not the raw string). A value that will not
 *  coerce is left as-is and fails the type check with a clear message. */
function coerceParam(doc: OpenApiDoc, schema: OpenApiSchema | undefined, raw: string): unknown {
  const s = resolveSchema(doc, schema);
  if (!s) return raw;
  // Which value types the schema permits coercion into: the explicit `type`(s), else inferred from a
  // typeless `const`/`enum` whose values are all numbers or all booleans. Without the inference, a
  // typeless numeric/boolean const/enum param (whose generated type is a number/boolean literal)
  // could never be satisfied by the wire string — every request would 400 against a type the runtime
  // otherwise never produces.
  let valueTypes = schemaValueTypes(s);
  if (valueTypes.length === 0) {
    if (typeof s.const === "number") valueTypes = ["number"];
    else if (typeof s.const === "boolean") valueTypes = ["boolean"];
    else if (Array.isArray(s.enum) && s.enum.length > 0) {
      if (s.enum.every((v) => typeof v === "number")) valueTypes = ["number"];
      else if (s.enum.every((v) => typeof v === "boolean")) valueTypes = ["boolean"];
    }
  }
  // Coerce order-independently for OpenAPI 3.1 multi-type unions: a schema that *allows* number or
  // boolean gets that coercion attempted regardless of where it sits in the `type` array (so
  // `["string","integer"]` and `["integer","string"]` behave identically). Each attempt falls back
  // to the raw string when it doesn't parse, preserving a value that only fits the union's `string`
  // arm. Number is tried before boolean so a numeric-looking value in a `number|boolean` union
  // becomes a number (`"true"`/`"false"` aren't numeric, so they still reach the boolean arm).
  if (valueTypes.includes("integer") || valueTypes.includes("number")) {
    const n = Number(raw);
    if (raw.trim() !== "" && !Number.isNaN(n)) return n;
  }
  if (valueTypes.includes("boolean")) {
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

  // The api `base` is the fixed `/app/api` constant; only the docs routing is derived here. Both
  // come from the shared helper (ADR 0058) so this module (which serves the docs) and `apiDocsPath`
  // (which links to them from the pages shell) stay in lockstep — no second, drifting copy of that
  // logic here. The spec JSON is served under the docs path so the operations namespace stays
  // purely operations.
  const { base, docsEnabled, docsBase } = resolveApiRoutes(binding);
  const dir = binding.dir ?? "operations";
  const surfaceEject = binding.eject === true;
  const specRoutePath = `${docsBase}/openapi.json`;
  // Fallback values for the RAW served spec + docs page. The interactive Swagger UI computes
  // ABSOLUTE spec + server URLs client-side from `window.location` (see `deriveSwaggerUrls`), which
  // is immune to a trailing slash on the docs URL and to the Nano console reverse-proxy prefix
  // (/console/app-view/<name>/). These document-relative values remain (a) the client's fallback
  // when the page path unexpectedly doesn't end in `docsBase`, and (b) what a non-interactive
  // consumer reading `openapi.json` directly sees. They still rebase onto the app's mount root
  // rather than using a root-absolute "/app/…" that would escape the proxy prefix (issue #151).
  const lastSegment = (p: string): string => p.split("/").filter(Boolean).pop() ?? "";
  const parentPath = (p: string): string => {
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return `/${parts.join("/")}`;
  };
  // `${docsBase}/openapi.json` reached relatively from the docs page = `<docs-segment>/openapi.json`.
  const specDocUrl = `${lastSegment(docsBase)}/openapi.json`;
  // `servers` can only be relativized when the operations `base` shares the docs page's parent
  // directory (the default `${base}-docs` sibling). For a fully custom `docs` path under a
  // different parent, keep the root-absolute base for the raw spec.
  const serversUrl = parentPath(base) === parentPath(docsBase) ? lastSegment(base) : base;

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

  // Lazily import + cache each delegate module, mirroring mountActions. This is the back-compat
  // fallback for apps without a generated controller registry (see loadController below).
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

  // Prefer the generated delegate registry (ADR 0059): one statically-typed barrel the toolkit
  // emits from the spec, so a missing/mismatched/orphan delegate is a `tsc` error, and dispatch is
  // a deterministic map lookup rather than a per-request path import. Imported ONCE and cached.
  // Absent (an app that hasn't re-genned) → `null`, and dispatch falls back to `loadModule`. A
  // present-but-broken controller (a delegate that throws at import) is NOT swallowed — it retries
  // and surfaces as a 500 with the reason, exactly like a bad delegate does today.
  let controllerPromise: Promise<Record<string, unknown> | null> | undefined;
  const loadController = (): Promise<Record<string, unknown> | null> => {
    if (!controllerPromise) {
      const rel = "nano-generated/controller";
      controllerPromise = (async () => {
        // Probe every supported module extension (compiled .js first, mirroring resolveModulePath),
        // NOT just `.ts`: a published / `urban run` app ships `controller.js` with the TS sources
        // absent, and probing only `.ts` there would wrongly report the registry missing and fall
        // back to per-op dynamic imports — defeating deterministic dispatch in production.
        let present = false;
        for (const ext of MODULE_EXTENSION_CANDIDATES) {
          if (await ctx.host.exists(resolveAppPath(ctx.root, rel + ext))) {
            present = true;
            break;
          }
        }
        if (!present) return null;
        const mod = await ctx.host.importModule(resolveAppPath(ctx.root, rel));
        const ops = mod.operations;
        if (!isRecord(ops)) {
          throw new Error("nano-generated/controller must export an `operations` registry");
        }
        return ops;
      })().catch((e) => {
        controllerPromise = undefined; // don't cache the failure — let a later request retry
        throw e;
      });
    }
    return controllerPromise;
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
          const undeclaredSchemes = undeclaredSecuritySchemes(d);
          if (undeclaredSchemes.length > 0) {
            ctx.host.log(
              "warn",
              "OpenAPI operations require a security scheme not declared in components.securitySchemes — those requests are rejected with 500 (ADR 0059)",
              { undeclared: undeclaredSchemes },
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

    // Enforce the operation's security requirements (ADR 0059) before touching the body or the
    // delegate: an unauthorized request should do no work and reveal nothing. Enforced even for
    // ejected ops (eject changes body handling, not who may call the operation).
    const authz = evaluateSecurity(
      d,
      op,
      (name) => req.headers.get(name) ?? undefined,
      (name) => req.query.get(name) ?? undefined,
      (envVar) => ctx.host.env(envVar),
    );
    if (!authz.ok) {
      if (authz.status === 500) {
        ctx.host.log("error", "OpenAPI operation security is misconfigured (ADR 0059)", {
          operationId: op.operationId,
          reason: authz.error,
        });
      }
      return json({ error: authz.error ?? "unauthorized" }, authz.status ?? 401);
    }

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
    // What the delegate actually receives: params/query coerced to their declared schema type. Seed
    // from the raw wire values (used verbatim for ejected ops and for undeclared/schemaless keys);
    // the validation loop below overwrites each declared parameter with its coerced value.
    const coercedParams: Record<string, unknown> = { ...params };
    const coercedQuery: Record<string, unknown> = { ...query };

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
          // Coerce once, forward the coerced value to the delegate (so a `count` param is a number
          // in the delegate's typed input, matching the generated schema type), and validate it.
          const coerced = coerceParam(d, p.schema, val);
          coercedParams[p.name] = coerced;
          issues.push(...validateValue(d, p.schema, coerced, `params/${p.name}`));
        } else if (p.in === "query") {
          const val = query[p.name];
          if (val === undefined) {
            if (p.required) issues.push({ path: `query/${p.name}`, message: "is required" });
            continue;
          }
          // A declared but schemaless query param has no shape to coerce/validate against — its
          // generated type is the raw wire `string | string[]`, so preserve raw semantics
          // (including repeated keys) and forward the value verbatim (already seeded in coercedQuery
          // from the raw wire). Don't route it through the scalar-repeat rejection below.
          if (!p.schema) continue;
          const values = Array.isArray(val) ? val : [val];
          const ps = resolveSchema(d, p.schema);
          if (ps && schemaHasType(ps, "array")) {
            // Repeated keys (?tag=a&tag=b) form the array; coerce + validate each item, then the
            // whole array against the schema's array constraints (minItems, items, ...). The coerced
            // array is what the delegate receives.
            const items = ps.items ? values.map((v) => coerceParam(d, ps.items, v)) : values;
            coercedQuery[p.name] = items;
            issues.push(...validateValue(d, ps, items, `query/${p.name}`));
          } else if (values.length > 1) {
            // A scalar (non-array) param that's repeated (?x=a&x=b) can't be forwarded as the
            // single schema-typed scalar the delegate's generated type expects — reject it (400)
            // rather than hand the delegate an array the type says is impossible.
            issues.push({ path: `query/${p.name}`, message: "expected a single value" });
          } else {
            // Scalar param: coerce the single value, forward it, and validate it.
            const coerced = coerceParam(d, p.schema, values[0]);
            coercedQuery[p.name] = coerced;
            issues.push(...validateValue(d, p.schema, coerced, `query/${p.name}`));
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
      const controller = await loadController();
      if (controller) {
        // Deterministic dispatch: the generated registry guarantees (at `tsc` time) one delegate
        // per operationId. A missing/non-function key here means the controller is stale vs the spec.
        const candidate = controller[op.operationId];
        if (!isFunction(candidate)) {
          ctx.host.log("error", "operation not registered in the generated controller (run `urban gen`)", {
            operationId: op.operationId,
          });
          return json({ error: `operation ${op.operationId} is not registered — run \`urban gen\`` }, 500);
        }
        handler = candidate;
      } else {
        handler = resolveOperationHandler(await loadModule(op.operationId));
      }
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
    // Hand the delegate an AppApi whose `log` is bound to this request's correlation context, so its
    // lines self-tag with `{ method, path, operationId }` without the author threading it.
    const requestApp: AppApi = {
      ...app,
      log: app.log.child({ method, path: op.path, operationId: op.operationId }),
    };
    try {
      const result = await handler(
        { req, params: coercedParams, query: coercedQuery, body: handlerBody },
        requestApp,
      );
      if (!result) return { status: 204 };
      const status = result.status ?? 200;
      // Optional response validation (dev by default): warn-only, never blocks the response.
      const mode = binding.validateResponses ?? "dev";
      const doValidate =
        mode === "always" || (mode === "dev" && ctx.host.env("NODE_ENV") !== "production");
      // Validate against the response schema for THIS status — exact status, else a matching status
      // range ("2XX"), else the "default" entry — so a documented error body (e.g. a 400 `{ error }`)
      // is checked against its own schema, not spuriously against the success response. A
      // documented-but-bodyless status carries no schema, so it (like a status with no `default`
      // fallback) is left unvalidated.
      const responseSchema = responseSchemaForStatus(op.responseSchemas, status);
      if (doValidate && responseSchema && result.body !== undefined) {
        const rIssues = validateValue(d, responseSchema, result.body, "response");
        if (rIssues.length > 0) {
          ctx.host.log("warn", "operation response failed schema validation (ADR 0058)", {
            operationId: op.operationId,
            issues: rIssues,
          });
        }
      }
      return {
        status,
        headers: { "content-type": "application/json", ...(result.headers ?? {}) },
        body: result.body === undefined ? undefined : JSON.stringify(result.body),
      };
    } catch (e) {
      // A write-once stub (or any delegate) can signal "endpoint exists, not implemented yet" with
      // a NotImplemented throw → 501, distinct from an unexpected fault (500).
      if (isNotImplemented(e)) {
        return json({ error: errorMessage(e), operationId: op.operationId }, 501);
      }
      return json({ error: errorMessage(e) }, 500);
    }
  };
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
    // (e.g. /app/api/invoices), not the spec's bare paths (/invoices). Overriding `servers` with a
    // document-relative URL (issue #151) makes the interactive console call the real Urban routes
    // both at the origin root and under the Nano console reverse proxy.
    return json({ ...d, servers: [{ url: serversUrl }] });
  };
  const docsTitle = `${ctx.manifest.name ?? "App"} — API docs`;
  const serveDocs = (): HttpResponse => html(swaggerUiPage(docsTitle, specDocUrl, docsBase, base));
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
