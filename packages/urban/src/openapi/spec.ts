// Shared, pure OpenAPI machinery for the Urban endpoint surface (ADR 0058). Both the toolkit
// deriver (`toolkit/derivers/api.ts`, authoring-time type + wrapper emission) and the runtime
// (`runtime/core/modules/api.ts`, request validation + routing) build on this one module, so the
// derived types and the runtime routes/validation always agree. No IO, no `node:*`, no `Deno` —
// it operates on document text/objects. Its one external dependency is `yaml` (a browser-safe,
// pure-JS parser with a dedicated browser build) so `parseSpec` accepts YAML — the sanctioned
// authoring format for the HTTP surface (ADR 0059) — as well as JSON.
//
// Scope: the ADR 0058 "supported profile" — JSON bodies, path/query parameters, a JSON
// requestBody, response codes, and a JSON-Schema subset validator (type/required/enum/numeric &
// string bounds/pattern/array & object shape/nullable/$ref). The `type` keyword is read in both
// OpenAPI 3.0 (a single string, `nullable: true` for null) and 3.1 (a `string[]`, e.g. the
// `type: [T, "null"]` nullable idiom or a multi-type union) dialects. Exotic OpenAPI (callbacks,
// links, XML, discriminated oneOf composition) is intentionally out of scope for this slice.

import { parse as parseYaml } from "yaml";

/** A JSON Schema (the OpenAPI subset we read). Kept structural and permissive — unknown keywords
 *  are ignored by the validator and fall back to `unknown` in the type emitter. */
export interface OpenApiSchema {
  $ref?: string;
  // OpenAPI 3.0 uses a single `type` string; JSON Schema 2020-12 (OpenAPI 3.1) also permits an
  // array of types, most commonly the nullable idiom `type: [T, "null"]`. Both dialects are read
  // via the `schemaTypeList`/`schemaValueTypes`/`schemaAllowsNull`/`schemaHasType` helpers so the
  // type emitter and the runtime validator treat a 3.1 type-array the same way.
  type?: string | string[];
  nullable?: boolean;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  // object
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  // array
  items?: OpenApiSchema;
  minItems?: number;
  maxItems?: number;
  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  // composition (best-effort)
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  description?: string;
}

/**
 * The declared JSON-Schema `type`(s) as a list, normalizing OpenAPI 3.0 (a single string) and
 * 3.1 (a `string[]`) into one shape. Returns `[]` when no `type` keyword is present, so callers
 * distinguish "typeless" (infer from other keywords) from "typed".
 */
export function schemaTypeList(schema: OpenApiSchema): string[] {
  if (schema.type === undefined) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** The declared non-"null" value types — what a 3.1 `type: [T, "null"]` permits as a value. */
export function schemaValueTypes(schema: OpenApiSchema): string[] {
  return schemaTypeList(schema).filter((t) => t !== "null");
}

/** The first declared non-"null" value type (for single-type scalar logic), or `undefined`. */
export function firstValueType(schema: OpenApiSchema): string | undefined {
  return schemaValueTypes(schema)[0];
}

/** Whether the schema permits an explicit `null` — via OpenAPI 3.0 `nullable: true` or the 3.1
 *  idiom `type: [..., "null"]`. */
export function schemaAllowsNull(schema: OpenApiSchema): boolean {
  return schema.nullable === true || schemaTypeList(schema).includes("null");
}

/** Whether the schema declares (permits) the given non-"null" value type. */
export function schemaHasType(schema: OpenApiSchema, t: string): boolean {
  return schemaValueTypes(schema).includes(t);
}

/**
 * Whether a schema describes an object shape. OpenAPI/JSON-Schema let the `type`
 * keyword be omitted when `properties`/`required`/`additionalProperties` already imply
 * an object. The type emitter (`schemaToTs`) and the runtime validator (`validateValue`)
 * both route object detection through this single predicate so they never drift — a body
 * the emitted type calls an object is the same body the validator shape-checks.
 */
export function isObjectSchema(schema: OpenApiSchema): boolean {
  const valueTypes = schemaValueTypes(schema);
  if (valueTypes.includes("object")) return true;
  if (valueTypes.length > 0) return false;
  return (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  );
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: OpenApiSchema;
  /** The parameter's schema with every local component `$ref` inlined (via {@link resolveSchemaDeep}),
   *  so a consumer that cannot resolve `#/components/...` — e.g. an MCP client reading the projected
   *  tool `inputSchema` — sees a self-contained schema. Absent when the parameter declares no schema.
   *  The raw {@link schema} is retained for the type deriver, which maps a `$ref` to its named type. */
  resolvedSchema?: OpenApiSchema;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

/**
 * A security scheme (OpenAPI Components Object → `securitySchemes`). The supported profile is the
 * `apiKey` type carried in a request header (ADR 0059): a webhook/operation is guarded by a shared
 * secret. The expected value is never inlined — it is read from an environment variable named by
 * the `x-nano-secret-env` extension (ADR 0025/0027: secrets stay env pointers).
 */
export interface OpenApiSecurityScheme {
  type?: string;
  /** For `apiKey`: where the key travels. `header` and `query` are enforced in this slice. */
  in?: "header" | "query" | "cookie";
  /** For `apiKey`: the header (or query) name carrying the key, e.g. `X-Webhook-Key`. */
  name?: string;
  /** Env var holding the expected secret value. Required to enforce an `apiKey` scheme. */
  "x-nano-secret-env"?: string;
  description?: string;
}

/** A security requirement: scheme name → scopes (scopes are unused for `apiKey`, always `[]`). An
 *  operation is authorized when ANY one requirement object is fully satisfied (OR across the list,
 *  AND within an object). An empty list (`security: []`) means the operation is explicitly open. */
export type OpenApiSecurityRequirement = Record<string, string[]>;

export interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  /** Document-level default security, applied to any operation that declares none. */
  security?: OpenApiSecurityRequirement[];
}

/** The HTTP methods we mount, lowercase as they appear as path-item keys. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;
export type HttpMethodLower = (typeof HTTP_METHODS)[number];

/** A single documented response: its status code ("200"), status range ("2XX"), or "default", and
 *  its JSON body schema when it documents one. `schema` is absent when the response is documented
 *  but carries no JSON body — recorded so an exact-status match can suppress the `default` fallback
 *  rather than mis-validating a bodyless status against the default (typically error) schema. */
export interface ResponseSchemaEntry {
  status: string;
  schema?: OpenApiSchema;
}

/** One resolved operation: its id, method, path, parameters, request body schema, and responses.
 *  This is the shared unit both the deriver (→ types) and the runtime (→ routes) consume. */
export interface OperationInfo {
  operationId: string;
  method: HttpMethodLower;
  /** The OpenAPI path template, e.g. "/invoices/{id}". */
  path: string;
  parameters: OpenApiParameter[];
  requestBodySchema?: OpenApiSchema;
  /** The request-body schema with every local component `$ref` deeply inlined (via
   *  {@link resolveSchemaDeep}), so it is self-contained: no `$ref`, and an explicit `type` where the
   *  referenced component declared one. This is what the MCP tool projection copies into a tool's
   *  `inputSchema.properties.body` — an MCP client cannot resolve `#/components/...` outside the
   *  original document, so the projected schema must carry the concrete shape. The raw
   *  {@link requestBodySchema} is retained alongside it for the type deriver (which maps a `$ref` to
   *  its named TypeScript type) and for `sharedRequestBodySchemas` (which fingerprints shared refs).
   *  Absent exactly when {@link requestBodySchema} is absent. Downstream slices (ADR 0067) read the
   *  resolved body `type` from here rather than re-resolving a possibly-`$ref` raw schema. */
  requestBodySchemaResolved?: OpenApiSchema;
  requestBodyRequired: boolean;
  /** Every documented JSON response, keyed by status code ("200","400",…,"default"), in a stable
   *  order. The type layer unions these into the operation's response type; the runtime validates a
   *  handler result against the entry matching its status (else "default"). */
  responseSchemas: ResponseSchemaEntry[];
  /** Effective security requirements (op-level if declared — including an explicit empty list —
   *  else the document-level default, else `[]`). An empty list means the operation is open. */
  security: OpenApiSecurityRequirement[];
  eject: boolean;
  /** Whether the operation opts OUT of MCP tool projection via the `x-mcp` extension (ADR 0067).
   *  Defaults to `false` — an operation IS exposed as a tool unless it explicitly excludes itself.
   *  Security-relevant: this is the single authoring switch that keeps an operator-only door (e.g.
   *  a human-gated dispatch) out of the agent-facing tool surface. See {@link isMcpExcluded}. */
  mcpExcluded: boolean;
  summary?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A structural gate for a schema object: any record is treated as a (loose) OpenAPI schema. */
function isSchema(v: unknown): v is OpenApiSchema {
  return isRecord(v);
}

/** Parse an OpenAPI document from text. Accepts both YAML (the sanctioned authoring format for
 *  the HTTP surface — ADR 0059) and JSON (still accepted, e.g. a generated interchange artifact).
 *  JSON is a strict subset of YAML 1.2, so JSON is tried first for a precise error + fast path,
 *  then the text is parsed as YAML. Throws with a clear message on malformed input. */
export function parseSpec(text: string): OpenApiDoc {
  let doc: unknown;
  try {
    // Fast path + precise diagnostics for JSON (and the generated `openapi.json` interchange file).
    doc = JSON.parse(text);
  } catch (jsonError) {
    // Not JSON — parse as YAML (which also subsumes JSON, so authored `.yaml`/`.yml` specs load).
    try {
      doc = parseYaml(text);
    } catch (yamlError) {
      const jsonMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
      const yamlMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
      throw new Error(`OpenAPI spec is not valid YAML or JSON: JSON parse error: ${jsonMessage}; YAML parse error: ${yamlMessage}`);
    }
  }
  if (!isRecord(doc)) {
    throw new Error("OpenAPI spec must be an object (a mapping at the document root)");
  }
  return doc;
}

/** The basename of a local `#/components/schemas/Name` ref, else undefined. */
export function refName(ref: string): string | undefined {
  const m = ref.match(/^#\/components\/schemas\/([^/]+)$/);
  return m ? m[1] : undefined;
}

/** Follow local component `$ref`s to the concrete schema (guarding cycles). Non-local refs → undefined. */
export function resolveSchema(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
): OpenApiSchema | undefined {
  if (!schema) return undefined;
  let current = schema;
  const seen = new Set<string>();
  while (current.$ref) {
    if (seen.has(current.$ref)) return undefined; // cyclic ref guard
    seen.add(current.$ref);
    const name = refName(current.$ref);
    const next = name ? doc.components?.schemas?.[name] : undefined;
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** Deeply inline every local component `$ref` in a schema, returning a self-contained schema with no
 *  `$ref` anywhere in its tree (top-level chain plus nested `properties`/`items`/
 *  `additionalProperties`/`allOf`/`oneOf`/`anyOf`). This is the resolver the MCP tool projection uses
 *  so a tool's `inputSchema` carries the concrete shape rather than an opaque `#/components/...`
 *  pointer an MCP client cannot follow (ADR 0067). It reuses the same local-ref semantics as
 *  {@link resolveSchema}, extended to recurse into subschemas.
 *
 *  Cycles and unresolvable refs FAIL LOUDLY rather than leak a `$ref`:
 *   - a `$ref` that reappears on its own resolution path (an irreducible cycle — a schema that
 *     cannot be finitely inlined) throws;
 *   - a `$ref` that is non-local or dangles (no matching `#/components/schemas/*`) throws.
 *  `seenRefs` tracks refs on the CURRENT path only, so a component referenced twice in sibling
 *  branches (a diamond) inlines fine — only genuine self-reference is rejected. */
export function resolveSchemaDeep(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
  seenRefs: ReadonlySet<string> = new Set(),
): OpenApiSchema | undefined {
  if (!schema) return undefined;
  let current: OpenApiSchema = schema;
  let seen = seenRefs;
  while (current.$ref) {
    const ref = current.$ref;
    if (seen.has(ref)) {
      throw new Error(
        `OpenAPI schema $ref cycle: ${[...seen, ref].join(" -> ")} cannot be inlined into a self-contained schema`,
      );
    }
    const name = refName(ref);
    const next = name ? doc.components?.schemas?.[name] : undefined;
    if (!next) {
      throw new Error(
        `OpenAPI schema $ref "${ref}" does not resolve to a local component — a self-contained schema cannot contain an unresolvable $ref`,
      );
    }
    seen = new Set(seen).add(ref);
    current = next;
  }
  const out: OpenApiSchema = { ...current };
  delete out.$ref;
  if (current.properties) {
    out.properties = Object.fromEntries(
      Object.entries(current.properties).map(([k, v]) => [k, resolveSchemaDeep(doc, v, seen) ?? {}]),
    );
  }
  if (current.items) out.items = resolveSchemaDeep(doc, current.items, seen);
  if (current.additionalProperties && typeof current.additionalProperties === "object") {
    out.additionalProperties = resolveSchemaDeep(doc, current.additionalProperties, seen);
  }
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const arr = current[key];
    if (arr) out[key] = arr.map((s) => resolveSchemaDeep(doc, s, seen) ?? {});
  }
  return out;
}

function firstJsonSchema(
  content: Record<string, unknown> | undefined,
): OpenApiSchema | undefined {
  if (!content) return undefined;
  const pick = (media: unknown): OpenApiSchema | undefined =>
    isRecord(media) && isSchema(media.schema) ? media.schema : undefined;
  // JSON-only: the runtime always JSON.parses the body and responds application/json, so derive
  // types/validation only from JSON media types (application/json, its charset variants, and any
  // `+json` structured suffix). A non-JSON media type is ignored rather than typed as if JSON.
  for (const [type, media] of Object.entries(content)) {
    const base = type.split(";", 1)[0].trim().toLowerCase();
    if (base === "application/json" || base.endsWith("+json")) {
      const s = pick(media);
      if (s) return s;
    }
  }
  return undefined;
}

/** Walk the document's paths and return every operation that carries an operationId, in a stable
 *  (path, method) order. Operations without an operationId are skipped here; the runtime mount logs
 *  them at `warn` and skips them too — this keeps the pure collector total. */
export function collectOperations(doc: OpenApiDoc): OperationInfo[] {
  const out: OperationInfo[] = [];
  const paths = doc.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    // Path-level parameters apply to every operation on the path (OpenAPI Path Item Object).
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!isRecord(opRaw)) continue;
      const operationId = typeof opRaw.operationId === "string" ? opRaw.operationId : undefined;
      if (!operationId || !isSafeOperationId(operationId)) continue;
      const opParams = Array.isArray(opRaw.parameters) ? opRaw.parameters : [];
      const parameters = normalizeParameters([...pathParams, ...opParams]).map((p) => ({
        ...p,
        // Inline any local component `$ref` so the projected MCP tool schema is self-contained. The
        // raw `p.schema` is kept for the type deriver; the tool projection reads `resolvedSchema`.
        resolvedSchema: resolveSchemaDeep(doc, p.schema),
      }));
      const requestBody = isRecord(opRaw.requestBody) ? opRaw.requestBody : undefined;
      const requestBodySchema = firstJsonSchema(
        isRecord(requestBody?.content) ? requestBody.content : undefined,
      );
      // Deeply inline component `$ref`s so downstream consumers (the MCP tool projection, ADR 0067)
      // get a self-contained, explicitly-typed body schema — never an opaque `#/components/...`
      // pointer. Raw `requestBodySchema` is retained (deriver + shared-ref fingerprinting). A cyclic
      // or unresolvable body ref fails loudly here rather than leaking a `$ref`.
      const requestBodySchemaResolved = resolveSchemaDeep(doc, requestBodySchema);
      const responses = isRecord(opRaw.responses) ? opRaw.responses : {};
      // Effective security: an operation's own `security` (even an explicit `[]`, which opts out of
      // a document-level default) wins; otherwise inherit the document-level default; otherwise open.
      const rawSecurity = Object.prototype.hasOwnProperty.call(opRaw, "security")
        ? opRaw.security
        : doc.security;
      const security = normalizeSecurity(rawSecurity);
      out.push({
        operationId,
        method,
        path,
        parameters,
        requestBodySchema,
        requestBodySchemaResolved,
        requestBodyRequired: requestBody?.required === true,
        responseSchemas: collectResponseSchemas(responses),
        security,
        eject: opRaw["x-urban-eject"] === true,
        mcpExcluded: isMcpExcluded(opRaw["x-mcp"]),
        summary: typeof opRaw.summary === "string" ? opRaw.summary : undefined,
      });
    }
  }
  return out;
}

/**
 * Read the `x-mcp` operation extension (ADR 0067 — MCP tool projection). An operation is EXPOSED as
 * an MCP tool by default; it is excluded only when it says so explicitly, so a spec author opts a
 * door OUT rather than every operation having to opt in. Recognised exclusion forms:
 *   - `x-mcp: false`            — a terse boolean opt-out;
 *   - `x-mcp: { exclude: true }` — the object form (room for future keys, e.g. per-tool metadata).
 * Any other value (including `x-mcp: true` / `{ exclude: false }` / absent) leaves the operation
 * exposed — fail-open to the documented default. This is a SECURITY-RELEVANT authoring rule: it is
 * the one switch that keeps an operator-only operation out of the agent-facing tool surface, so it
 * is enforced from the same single walker the runtime and the parity guard both read (no second
 * source of truth to drift, ADR 0053).
 */
export function isMcpExcluded(ext: unknown): boolean {
  if (ext === false) return true;
  return isRecord(ext) && ext.exclude === true;
}

/** The HTTP methods MCP treats as read-only (safe, non-mutating). These are exactly the HTTP "safe"
 *  verbs (RFC 9110 §9.2.1) that {@link HTTP_METHODS} can express: GET/HEAD, plus OPTIONS (a
 *  CORS/preflight metadata probe that never mutates). Every other method an operation can declare is
 *  a mutation whose tool is guarded (ADR 0067 Slice 3). */
const READ_ONLY_METHODS: readonly HttpMethodLower[] = ["get", "head", "options"];

/** Whether an operation's HTTP method mutates state — anything other than a safe read verb. Drives
 *  the MCP read/mutate split: read tools are unguarded on loopback, mutating tools are gated. */
export function isMutatingMethod(method: HttpMethodLower): boolean {
  return !READ_ONLY_METHODS.includes(method);
}

/** A JSON Schema (OpenAPI object subset) describing a tool's input, derived from an operation's
 *  path/query parameters and its request-body schema. It is the SINGLE derivation both the runtime
 *  MCP surface (`tools/list`) and the CI parity guard read, so a tool's advertised input schema and
 *  the HTTP validation it dispatches to can never drift (ADR 0053/0067).
 *
 *  Every property schema is taken from the operation's resolved (`$ref`-free) metadata — the
 *  parameters' `resolvedSchema` and the body's `requestBodySchemaResolved`, both produced by
 *  {@link resolveSchemaDeep} in {@link collectOperations} — so the emitted schema is self-contained:
 *  an MCP client, which cannot follow a `#/components/...` pointer outside the original document,
 *  sees the concrete shape (and an explicit `type` on the body). */
export function toolInputSchema(op: OperationInfo): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.parameters) {
    if (p.in === "path" || p.in === "query") {
      properties[p.name] = p.resolvedSchema ?? p.schema ?? {};
      if (p.required) required.push(p.name);
    }
  }
  const body = op.requestBodySchemaResolved;
  if (body) {
    properties.body = body;
    if (op.requestBodyRequired) required.push("body");
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Walk a JSON value (a projected tool schema) and return a pointer for every `$ref` still present.
 *  Empty means the schema is self-contained — no `#/components/...` an MCP client cannot resolve. The
 *  path is a dotted trail to each leak (e.g. `properties.body.properties.foo`). Pure/total. */
export function findSchemaRefLeaks(value: unknown, path = ""): string[] {
  const leaks: string[] = [];
  const visit = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (k === "$ref") leaks.push(p || "<root>");
        else visit(child, p ? `${p}.${k}` : k);
      }
    }
  };
  visit(value, path);
  return leaks;
}

/** Whether a (record-typed) schema declares an explicit JSON-Schema `type` — a non-empty string or a
 *  non-empty array of types. Operates on a raw record (not a typed {@link OpenApiSchema}) so it can
 *  vet a projected tool schema's `body` property without an unchecked cast. */
function hasExplicitType(schema: Record<string, unknown>): boolean {
  const t = schema.type;
  if (typeof t === "string") return t.length > 0;
  return Array.isArray(t) && t.length > 0;
}

/** Self-containment violations in one projected tool's `inputSchema`: any surviving `$ref` (an
 *  MCP client cannot resolve `#/components/...`), and — when the tool has a `body` property — a
 *  `body` that carries no explicit `type` (so the client cannot tell it is an object/array and
 *  mis-encodes the argument). Empty means the schema is a usable, self-contained input contract.
 *  This is the pure assertion the `check:mcp` guard runs over every projected tool (ADR 0067). */
export function findToolSchemaViolations(
  operationId: string,
  inputSchema: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  for (const leak of findSchemaRefLeaks(inputSchema)) {
    violations.push(`${operationId}: inputSchema leaks an unresolved $ref at ${leak}`);
  }
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : undefined;
  const body = properties && isRecord(properties.body) ? properties.body : undefined;
  if (body && !hasExplicitType(body)) {
    violations.push(`${operationId}: inputSchema.properties.body has no explicit \`type\``);
  }
  return violations;
}

/** Every self-containment violation across all projected (non-excluded) tools for a document — the
 *  aggregate the `check:mcp` guard fails on. Excluded operations are skipped: they are withheld from
 *  the live tool surface, so their schema is never advertised to a client. */
export function findAllToolSchemaViolations(doc: OpenApiDoc): string[] {
  const violations: string[] = [];
  for (const op of collectOperations(doc)) {
    if (op.mcpExcluded) continue;
    violations.push(...findToolSchemaViolations(op.operationId, toolInputSchema(op)));
  }
  return violations;
}

/** One operation's MCP-tool projection facts: its id, HTTP method, whether it mutates, whether
 *  `x-mcp` excludes it from projection, and its self-contained input schema. This is the shared unit
 *  the runtime MCP surface AND the CI spec↔tool parity guard both read — a single derivation of
 *  "which operations become tools and what each accepts", never a second walker (ADR 0053). */
export interface McpToolProjection {
  operationId: string;
  method: HttpMethodLower;
  mutating: boolean;
  excluded: boolean;
  /** The tool's `inputSchema` as advertised to an MCP client (absent for an excluded op, which is
   *  never advertised). Captured in the snapshot so a projection change — including a body `$ref`
   *  that stops being resolved — is caught by `check:mcp` drift, not discovered by a client. */
  inputSchema?: Record<string, unknown>;
}

/**
 * Project every operationId-bearing operation to its MCP-tool facts, in the stable
 * `collectOperations` (path, method) order. Excluded operations are RETAINED here (flagged
 * `excluded: true`) rather than dropped, so the parity guard can positively assert that an
 * `x-mcp`-excluded door is present-but-withheld — the runtime drops them when it builds the live
 * tool list. Derived entirely from {@link collectOperations}, so it can never diverge from what
 * `mountApi` routes. A non-excluded op also carries its self-contained {@link toolInputSchema}.
 */
export function collectMcpToolProjection(doc: OpenApiDoc): McpToolProjection[] {
  return collectOperations(doc).map((op) => ({
    operationId: op.operationId,
    method: op.method,
    mutating: isMutatingMethod(op.method),
    excluded: op.mcpExcluded,
    ...(op.mcpExcluded ? {} : { inputSchema: toolInputSchema(op) }),
  }));
}

/**
 * Compare a previously-captured MCP-tool projection (the committed snapshot) against the projection
 * freshly computed from the spec, returning a human-readable line for every skew — an operation the
 * spec now projects that the snapshot lacks, one the snapshot still lists that the spec no longer
 * projects, or one whose method / mutating / excluded facts changed. An empty array means the spec
 * and the projected tool list are in parity. This is the pure core of the `check:mcp` CI drift gate
 * (ADR 0067) — the same "generated derived artifact + fail-on-drift" pattern the repo already uses
 * for `check:runtime` — and is unit-tested by feeding it an injected skew.
 */
export function diffMcpToolProjection(
  snapshot: McpToolProjection[],
  current: McpToolProjection[],
): string[] {
  const drift: string[] = [];
  const byId = (list: McpToolProjection[]): Map<string, McpToolProjection> =>
    new Map(list.map((p) => [p.operationId, p]));
  const snapshotById = byId(snapshot);
  const currentById = byId(current);
  for (const [id, cur] of currentById) {
    const snap = snapshotById.get(id);
    if (!snap) {
      drift.push(`+ ${id}: spec projects a tool the snapshot is missing (regenerate the snapshot)`);
      continue;
    }
    if (snap.method !== cur.method || snap.mutating !== cur.mutating || snap.excluded !== cur.excluded) {
      drift.push(
        `~ ${id}: projection changed — snapshot {method:${snap.method}, mutating:${snap.mutating}, ` +
          `excluded:${snap.excluded}} vs spec {method:${cur.method}, mutating:${cur.mutating}, ` +
          `excluded:${cur.excluded}}`,
      );
    }
    if (JSON.stringify(snap.inputSchema ?? null) !== JSON.stringify(cur.inputSchema ?? null)) {
      drift.push(
        `~ ${id}: inputSchema changed — snapshot ${JSON.stringify(snap.inputSchema ?? null)} ` +
          `vs spec ${JSON.stringify(cur.inputSchema ?? null)}`,
      );
    }
  }
  for (const id of snapshotById.keys()) {
    if (!currentById.has(id)) {
      drift.push(`- ${id}: snapshot lists a tool the spec no longer projects (regenerate the snapshot)`);
    }
  }
  return drift;
}

/**
 * Every app shared-secret security scheme (ADR 0067/0059): the `apiKey` schemes in
 * `components.securitySchemes` presented in a request HEADER and pointing at an env var via
 * `x-nano-secret-env` (declared, even if empty — an empty pointer is a misconfiguration surfaced as
 * 500 downstream, not "no scheme"), in document (authoring) order. Single source of truth for both the guard
 * selector (`sharedSecretSchemeName`) and its ambiguity check — a mutating MCP tool REUSES the
 * app's existing shared secret (the same one a `webhook` trigger or a guarded operation already
 * uses) instead of minting an MCP-specific synonym.
 */
export function sharedSecretSchemeNames(doc: OpenApiDoc): string[] {
  const schemes = doc.components?.securitySchemes ?? {};
  const names: string[] = [];
  for (const [name, scheme] of Object.entries(schemes)) {
    // A malformed scheme value (e.g. `webhookKey:` with no body parses as `null` in YAML, or a
    // primitive) is not a valid apiKey shared-secret candidate — skip it rather than dereference it
    // and throw a bare TypeError. This mirrors `evaluateSecurity`, which never treats a non-object
    // scheme as a valid credential (a referenced null/primitive scheme surfaces there as a 500), so
    // there is no silent security hole: mutations fail closed and a genuine misconfig is caught at
    // request time by the enforcement path.
    if (!isRecord(scheme)) continue;
    // Structural presence check (`typeof … === "string"`), NOT truthiness: a declared-but-EMPTY
    // `x-nano-secret-env` is a misconfiguration, not "no scheme". Selecting it here lets
    // `evaluateSecurity` surface it as a 500 (missing env-var pointer) — the same way it treats an
    // empty pointer — instead of silently dropping the scheme so the guard reports a misleading 401.
    if (
      scheme.type === "apiKey" &&
      (scheme.in ?? "header") === "header" &&
      typeof scheme["x-nano-secret-env"] === "string"
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * The name of the app's single shared-secret security scheme (ADR 0067/0059) — the credential the
 * framework MUTATING MCP tools require. `undefined` when the app declares no such scheme, in which
 * case the mutating tools stay closed unless an explicit runtime opt-in is set.
 *
 * THROWS when the spec declares MORE THAN ONE candidate: which scheme becomes "the" MCP mutation
 * guard would otherwise depend on `securitySchemes` object iteration (authoring) order, silently
 * guarding with an unintended secret (or rejecting a different, valid shared-secret header). That is
 * an incoherent spec, surfaced loudly — the caller maps it to a 500 misconfiguration — rather than
 * resolved by an invisible "first wins" rule. Derived from `sharedSecretSchemeNames` (no drift).
 */
export function sharedSecretSchemeName(doc: OpenApiDoc): string | undefined {
  const names = sharedSecretSchemeNames(doc);
  if (names.length > 1) {
    throw new Error(
      `OpenAPI spec declares multiple shared-secret schemes (apiKey header with x-nano-secret-env): ` +
        `${names.join(", ")}. Exactly one may serve as the MCP mutation guard — remove the extras so ` +
        "the guard scheme is unambiguous.",
    );
  }
  return names[0];
}

/**
 * Throw if the document declares the same `operationId` on more than one operation. An operationId
 * must be unique across the whole OpenAPI document (it names the delegate module `<dir>/<operationId>`
 * AND the generated controller registry key), so a duplicate would silently overwrite an earlier
 * entry in the emitted object literal — dispatching the wrong delegate while still type-checking — and
 * make the scaffolder plan the same stub twice. Called by the gen/scaffold path so `urban gen`
 * fails loudly on an incoherent spec instead of shipping a mis-dispatching registry.
 */
export function assertUniqueOperationIds(doc: OpenApiDoc): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const op of collectOperations(doc)) {
    if (seen.has(op.operationId)) duplicates.add(op.operationId);
    seen.add(op.operationId);
  }
  if (duplicates.size > 0) {
    const list = [...duplicates].sort().join(", ");
    throw new Error(
      `OpenAPI spec declares duplicate operationId(s): ${list}. Each operationId must be unique — ` +
        "it names the delegate module and the generated controller registry key.",
    );
  }
}

/** Groups of operationIds that name the SAME requestBody schema `$ref` as their JSON body,
 *  keyed by that ref (only refs shared by two or more operations are returned, sorted). A single
 *  request-body schema reused verbatim by multiple operations is the structural fingerprint of the
 *  "one permissive schema standing in for what should be mutually-exclusive variants" defect: two
 *  operations that genuinely want different shapes (e.g. `startConvergenceLoop` wants pr|url,
 *  `startPlanFanout` wants issue|url) are forced to share one loose object, so neither can be
 *  tightened without breaking the other. gen surfaces this as a non-fatal warning so an author can
 *  split it into per-operation named variants + `oneOf` (the Camunda REST v2 pattern). Structural
 *  only (pure, total) — the message is built by the caller. */
export function sharedRequestBodySchemas(doc: OpenApiDoc): { ref: string; operationIds: string[] }[] {
  const byRef = new Map<string, string[]>();
  for (const op of collectOperations(doc)) {
    const ref = op.requestBodySchema?.$ref;
    if (typeof ref !== "string" || ref.length === 0) continue;
    const ids = byRef.get(ref) ?? [];
    ids.push(op.operationId);
    byRef.set(ref, ids);
  }
  const out: { ref: string; operationIds: string[] }[] = [];
  for (const [ref, ids] of byRef) {
    if (ids.length > 1) out.push({ ref, operationIds: [...ids].sort() });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));
  return out;
}

/** "method path" pointers for every operation that declares no `operationId`. Such operations are
 *  unroutable (no delegate to bind), so the runtime mount logs them at `warn` and skips them. */
export function operationsWithoutId(doc: OpenApiDoc): string[] {
  const missing: string[] = [];
  const paths = doc.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!isRecord(opRaw)) continue;
      if (typeof opRaw.operationId !== "string" || opRaw.operationId.length === 0) {
        missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return missing;
}

/** "METHOD path {param}" pointers for every path-template parameter that no declared `in: "path"`
 *  parameter covers. Such params are still captured and passed to the delegate at runtime, but are
 *  neither typed (the deriver only emits declared params) nor validated — a type/runtime drift the
 *  runtime mount surfaces at `warn`. */
export function undeclaredPathParams(doc: OpenApiDoc): string[] {
  const out: string[] = [];
  for (const op of collectOperations(doc)) {
    const declared = new Set(op.parameters.filter((p) => p.in === "path").map((p) => p.name));
    for (const m of op.path.matchAll(/\{([^}]+)\}/g)) {
      if (!declared.has(m[1])) out.push(`${op.method.toUpperCase()} ${op.path} {${m[1]}}`);
    }
  }
  return out;
}

/** An operationId names the delegate module file (`<dir>/<operationId>`), so it must be a single
 *  safe path segment. Rejects separators and parent-dir traversal so a crafted spec can't import a
 *  file outside the operations directory. Single source of truth for the rule (used by the pure
 *  collector, the diagnostic collector, and the runtime import sink). */
export function isSafeOperationId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") && id !== ".";
}

/** "METHOD path (operationId)" pointers for operations whose operationId is present but not a safe
 *  path segment. collectOperations skips these (they never mount or drive an import); the runtime
 *  surfaces them at `warn`. */
export function operationsWithUnsafeId(doc: OpenApiDoc): string[] {
  const out: string[] = [];
  const paths = doc.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!isRecord(opRaw)) continue;
      const id = opRaw.operationId;
      if (typeof id === "string" && id.length > 0 && !isSafeOperationId(id)) {
        out.push(`${method.toUpperCase()} ${path} (${id})`);
      }
    }
  }
  return out;
}

const MALFORMED_SECURITY_REQUIREMENT = "__nano_malformed_security_requirement__";

function malformedSecurityRequirement(): OpenApiSecurityRequirement {
  return { [MALFORMED_SECURITY_REQUIREMENT]: [] };
}

/** Normalize a raw `security` value into a clean requirement list. Missing → `[]` (open).
 *  Present-but-malformed values become an impossible marker requirement so enforcement fails closed
 *  as a 500 misconfiguration instead of silently opening a guarded operation. */
function normalizeSecurity(raw: unknown): OpenApiSecurityRequirement[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [malformedSecurityRequirement()];
  const out: OpenApiSecurityRequirement[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      out.push(malformedSecurityRequirement());
      continue;
    }
    const req: OpenApiSecurityRequirement = {};
    let malformed = false;
    for (const [name, scopes] of Object.entries(entry)) {
      if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) {
        malformed = true;
        break;
      }
      req[name] = scopes;
    }
    out.push(malformed ? malformedSecurityRequirement() : req);
  }
  return out;
}

/** The outcome of enforcing an operation's security: `ok` when authorized, otherwise the HTTP
 *  status to return — `401` (the request presented no/invalid credential) or `500` (the app is
 *  misconfigured: an operation references an unknown scheme, an unsupported scheme type, or a
 *  scheme whose secret env var is unset). */
export interface SecurityDecision {
  ok: boolean;
  status?: 401 | 500;
  error?: string;
}

const SECURITY_OK: SecurityDecision = { ok: true };
const TEXT_ENCODER = new TextEncoder();

/** Constant-time string comparison — avoids leaking how many leading characters of a secret matched
 *  via response timing. Unequal lengths short-circuit (an acceptable length oracle for API keys). */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = TEXT_ENCODER.encode(a);
  const bb = TEXT_ENCODER.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Enforce an operation's effective security requirements (ADR 0059). Pure: the caller supplies the
 * request's header/query readers and an env reader, so all policy lives here (and is unit-tested)
 * while the impure lookups stay in the runtime.
 *
 * Semantics follow OpenAPI: authorized when ANY one requirement object is satisfied (OR), and a
 * requirement object is satisfied only when ALL its schemes are (AND). An empty requirement list
 * means the operation is open. Only `apiKey` schemes (in `header` or `query`) are enforced; the
 * expected value comes from the scheme's `x-nano-secret-env` env var.
 *
 * A referenced scheme that is unknown, not `apiKey`, or missing its secret env var is a server
 * misconfiguration → `500` (fail closed), reported in preference to a `401` so operators see the
 * real cause. A well-formed scheme with a wrong/absent presented credential → `401`.
 */
export function evaluateSecurity(
  doc: OpenApiDoc,
  op: OperationInfo,
  getHeader: (name: string) => string | undefined,
  getQuery: (name: string) => string | undefined,
  getSecret: (envVar: string) => string | undefined,
): SecurityDecision {
  if (op.security.length === 0) return SECURITY_OK;
  const schemes = doc.components?.securitySchemes ?? {};
  let misconfig: string | undefined;

  for (const requirement of op.security) {
    const names = Object.keys(requirement);
    if (names.length === 0) return SECURITY_OK; // an empty object is a "no auth" alternative
    let satisfied = true;
    for (const name of names) {
      if (name === MALFORMED_SECURITY_REQUIREMENT) {
        misconfig ??= "malformed security requirement";
        satisfied = false;
        break;
      }
      const scheme = schemes[name];
      if (!scheme) {
        misconfig ??= `security scheme "${name}" is not declared in components.securitySchemes`;
        satisfied = false;
        break;
      }
      if (scheme.type !== "apiKey") {
        misconfig ??= `security scheme "${name}" has unsupported type "${scheme.type ?? "(none)"}" (only apiKey is enforced)`;
        satisfied = false;
        break;
      }
      const where = scheme.in ?? "header";
      if (where !== "header" && where !== "query") {
        misconfig ??= `security scheme "${name}" apiKey location "${where}" is unsupported (use header or query)`;
        satisfied = false;
        break;
      }
      if (!scheme.name) {
        misconfig ??= `security scheme "${name}" is missing its apiKey \`name\``;
        satisfied = false;
        break;
      }
      const envVar = scheme["x-nano-secret-env"];
      if (!envVar) {
        misconfig ??= `security scheme "${name}" is missing \`x-nano-secret-env\` (the env var holding the expected key)`;
        satisfied = false;
        break;
      }
      const expected = getSecret(envVar);
      if (expected === undefined || expected === "") {
        misconfig ??= `security scheme "${name}" secret env ${envVar} is not set`;
        satisfied = false;
        break;
      }
      const presented = where === "header" ? getHeader(scheme.name) : getQuery(scheme.name);
      if (presented === undefined || !timingSafeEqual(presented, expected)) {
        satisfied = false; // a wrong/absent credential → 401 (not a misconfig)
        break;
      }
    }
    if (satisfied) return SECURITY_OK;
  }

  return misconfig
    ? { ok: false, status: 500, error: `security misconfigured: ${misconfig}` }
    : { ok: false, status: 401, error: "unauthorized" };
}

/** "scheme (op)" pointers for every operation security requirement that names a scheme absent from
 *  components.securitySchemes — an app-drift the runtime rejects at request time (500) and the
 *  `--check` gate can surface ahead of time. */
export function undeclaredSecuritySchemes(doc: OpenApiDoc): string[] {
  const declared = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
  const out: string[] = [];
  for (const op of collectOperations(doc)) {
    for (const requirement of op.security) {
      for (const name of Object.keys(requirement)) {
        if (name !== MALFORMED_SECURITY_REQUIREMENT && !declared.has(name)) {
          out.push(`${name} (${op.method.toUpperCase()} ${op.path})`);
        }
      }
    }
  }
  return out;
}

function normalizeParameters(raw: unknown[]): OpenApiParameter[] {
  // OpenAPI: parameters are uniquely identified by (name, in). A path-level parameter can be
  // overridden by an operation-level one with the same (name, in) — never duplicated. Callers pass
  // [...pathParams, ...opParams], so dedup later-wins (op overrides path) while preserving the
  // first-seen position, so the emitted binding never carries two `path`/`query` fields with the
  // same name (which would collide in the generated params/query types and in runtime extraction).
  const byKey = new Map<string, OpenApiParameter>();
  const order: string[] = [];
  for (const p of raw) {
    if (!isRecord(p)) continue;
    const name = typeof p.name === "string" ? p.name : undefined;
    const location = typeof p.in === "string" ? p.in : undefined;
    if (!name || !location) continue;
    if (location !== "path" && location !== "query" && location !== "header" && location !== "cookie") {
      continue;
    }
    const schema = isRecord(p.schema) ? p.schema : undefined;
    const key = `${location}\u0000${name}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, { name, in: location, required: p.required === true, schema });
  }
  return order.map((k) => byKey.get(k)!);
}

/** Every documented response, in a stable order: numeric status codes ascending, then status
 *  ranges ("1XX".."5XX"), then "default" last. A response with no JSON body schema is still
 *  recorded (with `schema` undefined) so an exact-status match suppresses the `default` fallback
 *  instead of the bodyless status being mis-validated against the default (error) schema. */
function collectResponseSchemas(responses: Record<string, unknown>): ResponseSchemaEntry[] {
  const isExact = (c: string) => /^\d{3}$/.test(c);
  const isRange = (c: string) => /^[1-5]XX$/i.test(c);
  const keys = Object.keys(responses).filter((c) => isExact(c) || isRange(c) || c === "default");
  const rank = (c: string) => (c === "default" ? 2 : isRange(c) ? 1 : 0);
  keys.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out: ResponseSchemaEntry[] = [];
  for (const key of keys) {
    const resp = responses[key];
    if (!isRecord(resp)) continue;
    const status = isRange(key) ? key.toUpperCase() : key;
    const schema = firstJsonSchema(isRecord(resp.content) ? resp.content : undefined);
    out.push(schema ? { status, schema } : { status });
  }
  return out;
}

/** Select the response schema to validate a handler result against: exact status → status range
 *  ("2XX") → "default". A documented-but-bodyless exact status (or range) returns undefined (no
 *  validation) and does NOT fall through to `default` — the status IS documented, it just carries no
 *  JSON body, so validating it against an unrelated (e.g. error `default`) schema would be wrong. An
 *  UNdocumented status falls back to the `default` entry when present, else undefined. */
export function responseSchemaForStatus(
  entries: ResponseSchemaEntry[],
  status: number,
): OpenApiSchema | undefined {
  const exact = entries.find((e) => e.status === String(status));
  if (exact) return exact.schema;
  const range = entries.find((e) => e.status === `${Math.floor(status / 100)}XX`);
  if (range) return range.schema;
  return entries.find((e) => e.status === "default")?.schema;
}

/** Turn an OpenAPI path template ("/invoices/{id}") into a matcher under `base` ("/app/api"):
 *  a RegExp that captures each `{param}` positionally, plus the ordered path-parameter names. The
 *  runtime matches concrete request paths, so a templated segment becomes a single-segment capture. */
/** Escape RegExp metacharacters so a string is matched literally inside a `new RegExp(...)`. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toRouteMatcher(
  base: string,
  path: string,
): { pattern: RegExp; paramNames: string[]; sample: string } {
  const cleanBase = base.replace(/\/+$/, "");
  const paramNames: string[] = [];
  const segments = path.split("/").filter((s) => s.length > 0);
  const regexParts = segments.map((seg) => {
    const m = seg.match(/^\{([^}]+)\}$/);
    if (m) {
      paramNames.push(m[1]);
      return "([^/]+)";
    }
    return escapeRegex(seg);
  });
  const body = regexParts.length > 0 ? `/${regexParts.join("/")}` : "";
  // `base` is a literal path prefix (e.g. "/app/api(v2)"), not a pattern — escape its metacharacters
  // just like the static template segments so it can't alter or break the matcher.
  const pattern = new RegExp(`^${escapeRegex(cleanBase)}${body}/?$`);
  const sample = `${cleanBase}${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
  return { pattern, paramNames, sample };
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────

/** One validation failure: a JSON-pointer-ish path and a human message. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Structural (deep) equality for JSON values — enum/const members can be objects or arrays, which
 *  a parsed request will never be `===` to. Compares by shape so those comparisons are correct. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]),
    );
  }
  return false;
}

function typeOfValue(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isInteger(v)) return "integer";
  return typeof v;
}

function matchesType(declared: string, value: unknown): boolean {
  const actual = typeOfValue(value);
  if (declared === "number") return actual === "number" || actual === "integer";
  if (declared === "integer") return actual === "integer";
  if (declared === "null") return value === null;
  return actual === declared;
}

/** Whether `value` matches any of the declared value types (a 3.1 `type` list is a union). */
function matchesAnyType(declared: string[], value: unknown): boolean {
  return declared.some((t) => matchesType(t, value));
}

/** A short, human-readable label for one `anyOf`/`oneOf` variant, so a composition failure can name
 *  the allowed shapes instead of an opaque "matched 0". Prefers the variant's discriminant — its
 *  `required` fields (e.g. `{pr}` vs `{url}`) — since that is exactly what a caller must choose
 *  between; falls back to the declared type(s), else "object". */
function variantLabel(doc: OpenApiDoc, variant: OpenApiSchema): string {
  const s = resolveSchema(doc, variant);
  if (!s) return "?";
  const req = Array.isArray(s.required) ? s.required : [];
  if (req.length > 0) return `{${req.join(", ")}}`;
  const types = schemaTypeList(s);
  return types.length > 0 ? types.join("|") : "object";
}

/** The `(allowed: {pr} | {url})` suffix for a composition-failure summary message. */
function variantSummary(doc: OpenApiDoc, variants: OpenApiSchema[]): string {
  return ` (allowed: ${variants.map((v) => variantLabel(doc, v)).join(" | ")})`;
}

/** When a `oneOf`/`anyOf` matched no variant, surface actionable detail: the issues of the variant
 *  the value was CLOSEST to (fewest problems). For the discriminant case this is the shape the
 *  caller meant, so its issues read like `pr: is required` / `url: is not an allowed property`
 *  instead of a bare "matched 0". Ties resolve to the earliest variant (declaration order). */
function closestVariantIssues(perVariant: ValidationIssue[][]): ValidationIssue[] {
  let best: ValidationIssue[] | undefined;
  for (const iss of perVariant) {
    if (best === undefined || iss.length < best.length) best = iss;
  }
  return best ?? [];
}

/** Validate `value` against `schema` (resolving local $refs against `doc`), returning every issue
 *  found (empty = valid). A pragmatic JSON-Schema subset; unknown keywords are ignored. */
export function validateValue(
  doc: OpenApiDoc,
  schemaIn: OpenApiSchema | undefined,
  value: unknown,
  path = "",
): ValidationIssue[] {
  const schema = resolveSchema(doc, schemaIn);
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const at = path || "(root)";

  if (value === null) {
    if (schemaAllowsNull(schema)) return issues;
    // enum/const may explicitly permit null even without `nullable`.
    if (schema.enum && schema.enum.some((e) => e === null)) return issues;
    if (schema.const === null) return issues;
    // Otherwise null is invalid for a typed schema, an object schema (properties/required imply
    // object), or an enum/const that doesn't list null. A truly empty schema ({}) allows anything.
    const valueTypes = schemaValueTypes(schema);
    if (schema.enum) {
      issues.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
    } else if (schema.const !== undefined) {
      issues.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
    } else if (valueTypes.length > 0) {
      issues.push({ path: at, message: `expected ${valueTypes.join(",")}, got null` });
    } else if (isObjectSchema(schema)) {
      issues.push({ path: at, message: "expected object, got null" });
    }
    return issues;
  }

  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    issues.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    issues.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  // Composition keywords — kept in lockstep with schemaToTs, which emits `allOf` as an intersection
  // and `anyOf`/`oneOf` as unions. Runs before the `type` early-return since a composed schema may
  // omit a top-level `type` and carry it on the sub-schemas instead.
  if (schema.allOf) {
    for (const sub of schema.allOf) issues.push(...validateValue(doc, sub, value, path));
  }
  if (schema.anyOf) {
    // `anyOf` needs only ONE match, so short-circuit on the first clean variant — `validateValue`
    // runs on every request (params/query/body/response) and evaluating every variant for a large
    // schema is needless work once we have a hit. Only when NO variant matches do we build the full
    // per-variant issue list to name the allowed shapes and surface the closest variant's issues.
    let anyMatched = false;
    const perVariant: ValidationIssue[][] = [];
    for (const sub of schema.anyOf) {
      const subIssues = validateValue(doc, sub, value, path);
      if (subIssues.length === 0) {
        anyMatched = true;
        break;
      }
      perVariant.push(subIssues);
    }
    if (!anyMatched) {
      issues.push({
        path: at,
        message: `does not match any of the ${schema.anyOf.length} allowed shapes${variantSummary(doc, schema.anyOf)}`,
      });
      issues.push(...closestVariantIssues(perVariant));
    }
  }
  if (schema.oneOf) {
    const perVariant = schema.oneOf.map((sub) => validateValue(doc, sub, value, path));
    const matched = perVariant.filter((v) => v.length === 0).length;
    if (matched === 0) {
      // No variant matched: name the allowed shapes AND surface the closest variant's issues, so a
      // discriminated body (e.g. exactly one of pr|url) fails with actionable detail, not "matched 0".
      issues.push({
        path: at,
        message: `does not match any of the ${schema.oneOf.length} allowed shapes${variantSummary(doc, schema.oneOf)}`,
      });
      issues.push(...closestVariantIssues(perVariant));
    } else if (matched > 1) {
      // Matched more than one: the shapes are not mutually exclusive for this value (usually a body
      // that supplies two discriminants, or under-constrained variants). Report the ambiguity.
      issues.push({
        path: at,
        message: `must match exactly one of the ${schema.oneOf.length} allowed shapes, but matched ${matched}${variantSummary(doc, schema.oneOf)}`,
      });
    }
  }

  // `value` is non-null here (the null branch returned above), so match against the declared value
  // types. Use the full `type` list — not `schemaValueTypes` — so a null-only schema (`["null"]`)
  // still rejects non-null values instead of skipping the check on an empty value-type list.
  const declaredTypes = schemaTypeList(schema);
  if (declaredTypes.length > 0 && !matchesAnyType(declaredTypes, value)) {
    issues.push({ path: at, message: `expected ${declaredTypes.join(",")}, got ${typeOfValue(value)}` });
    return issues; // the shape checks below assume the declared type held
  }

  if (schemaHasType(schema, "string") && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path: at, message: `shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path: at, message: `longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        // A malformed pattern is a spec-author error, not client input. Surface it as a
        // controlled failure (the dispatcher's outer catch maps it to a 500 with this
        // message) instead of letting `new RegExp` throw an opaque error deep in
        // validation and crash the host request handler.
        throw new Error(`schema at ${at}: invalid pattern ${JSON.stringify(schema.pattern)}`);
      }
      if (!re.test(value)) {
        issues.push({ path: at, message: `does not match pattern ${schema.pattern}` });
      }
    }
  }

  if ((schemaHasType(schema, "number") || schemaHasType(schema, "integer")) && typeof value === "number") {
    // OpenAPI 3.0 uses the boolean form (`exclusiveMinimum: true` makes `minimum` exclusive);
    // JSON Schema 2020-12 (OpenAPI 3.1) uses the numeric form (`exclusiveMinimum: <number>`).
    // Support both so specs in either dialect are validated, not silently under-checked.
    const minExclusive = schema.exclusiveMinimum === true;
    const maxExclusive = schema.exclusiveMaximum === true;
    if (schema.minimum !== undefined && (minExclusive ? value <= schema.minimum : value < schema.minimum)) {
      issues.push({
        path: at,
        message: minExclusive ? `must be > ${schema.minimum}` : `less than minimum ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && (maxExclusive ? value >= schema.maximum : value > schema.maximum)) {
      issues.push({
        path: at,
        message: maxExclusive ? `must be < ${schema.maximum}` : `greater than maximum ${schema.maximum}`,
      });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      issues.push({ path: at, message: `must be > ${schema.exclusiveMinimum}` });
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      issues.push({ path: at, message: `must be < ${schema.exclusiveMaximum}` });
    }
  }

  if (schemaHasType(schema, "array") && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path: at, message: `fewer than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path: at, message: `more than maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...validateValue(doc, schema.items, item, `${path}[${i}]`));
      });
    }
  }

  if (isObjectSchema(schema)) {
    if (!isRecord(value)) {
      // A typeless object schema (properties/required imply object, but `type` is omitted) skips
      // the type check above, so guard here — otherwise a non-object like `42` or `[]` would pass.
      issues.push({ path: at, message: `expected object, got ${typeOfValue(value)}` });
      return issues;
    }
    for (const req of schema.required ?? []) {
      if (!Object.hasOwn(value, req)) issues.push({ path: `${path}/${req}`, message: "is required" });
    }
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) issues.push(...validateValue(doc, propSchema, value[key], `${path}/${key}`));
    }
    const extra = schema.additionalProperties;
    if (extra === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) issues.push({ path: `${path}/${key}`, message: "is not an allowed property" });
      }
    } else if (isRecord(extra)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) issues.push(...validateValue(doc, extra, value[key], `${path}/${key}`));
      }
    }
  }

  return issues;
}
