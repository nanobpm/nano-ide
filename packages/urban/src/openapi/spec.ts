// Shared, pure OpenAPI machinery for the Urban endpoint surface (ADR 0058). Both the toolkit
// deriver (`toolkit/derivers/api.ts`, authoring-time type + wrapper emission) and the runtime
// (`runtime/core/modules/api.ts`, request validation + routing) build on this one module, so the
// derived types and the runtime routes/validation always agree. No IO, no `node:*`, no `Deno` —
// it operates on an already-parsed document object.
//
// Scope: the ADR 0058 "supported profile" — JSON bodies, path/query parameters, a JSON
// requestBody, response codes, and a JSON-Schema subset validator (type/required/enum/numeric &
// string bounds/pattern/array & object shape/nullable/$ref). Exotic OpenAPI (callbacks, links,
// XML, discriminated oneOf composition) is intentionally out of scope for this slice.

/** A JSON Schema (the OpenAPI subset we read). Kept structural and permissive — unknown keywords
 *  are ignored by the validator and fall back to `unknown` in the type emitter. */
export interface OpenApiSchema {
  $ref?: string;
  type?: string;
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
 * Whether a schema describes an object shape. OpenAPI/JSON-Schema let the `type`
 * keyword be omitted when `properties`/`required`/`additionalProperties` already imply
 * an object. The type emitter (`schemaToTs`) and the runtime validator (`validateValue`)
 * both route object detection through this single predicate so they never drift — a body
 * the emitted type calls an object is the same body the validator shape-checks.
 */
export function isObjectSchema(schema: OpenApiSchema): boolean {
  if (schema.type === "object") return true;
  if (schema.type !== undefined) return false;
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

export interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

/** The HTTP methods we mount, lowercase as they appear as path-item keys. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;
export type HttpMethodLower = (typeof HTTP_METHODS)[number];

/** One resolved operation: its id, method, path, parameters, request body schema, and responses.
 *  This is the shared unit both the deriver (→ types) and the runtime (→ routes) consume. */
export interface OperationInfo {
  operationId: string;
  method: HttpMethodLower;
  /** The OpenAPI path template, e.g. "/invoices/{id}". */
  path: string;
  parameters: OpenApiParameter[];
  requestBodySchema?: OpenApiSchema;
  requestBodyRequired: boolean;
  /** Schema of the first 2xx (else default) JSON response, when declared. */
  responseSchema?: OpenApiSchema;
  eject: boolean;
  summary?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A structural gate for a schema object: any record is treated as a (loose) OpenAPI schema. */
function isSchema(v: unknown): v is OpenApiSchema {
  return isRecord(v);
}

/** Parse an OpenAPI document from text. JSON only in this slice (ADR 0058 open question: YAML).
 *  Throws with a clear message on malformed input. */
export function parseSpec(text: string): OpenApiDoc {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `OpenAPI spec is not valid JSON (YAML is not yet supported — ADR 0058): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (!isRecord(doc)) throw new Error("OpenAPI spec must be a JSON object");
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
      if (!operationId) continue;
      const opParams = Array.isArray(opRaw.parameters) ? opRaw.parameters : [];
      const parameters = normalizeParameters([...pathParams, ...opParams]);
      const requestBody = isRecord(opRaw.requestBody) ? opRaw.requestBody : undefined;
      const requestBodySchema = firstJsonSchema(
        isRecord(requestBody?.content) ? requestBody.content : undefined,
      );
      const responses = isRecord(opRaw.responses) ? opRaw.responses : {};
      out.push({
        operationId,
        method,
        path,
        parameters,
        requestBodySchema,
        requestBodyRequired: requestBody?.required === true,
        responseSchema: firstSuccessSchema(responses),
        eject: opRaw["x-urban-eject"] === true,
        summary: typeof opRaw.summary === "string" ? opRaw.summary : undefined,
      });
    }
  }
  return out;
}

/** Every operationId declared on an operation whose operationId is missing — the mount + check
 *  surface these as fail-closed errors (ADR 0027 §4). Returns "method path" pointers. */
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

function normalizeParameters(raw: unknown[]): OpenApiParameter[] {
  const params: OpenApiParameter[] = [];
  for (const p of raw) {
    if (!isRecord(p)) continue;
    const name = typeof p.name === "string" ? p.name : undefined;
    const location = typeof p.in === "string" ? p.in : undefined;
    if (!name || !location) continue;
    if (location !== "path" && location !== "query" && location !== "header" && location !== "cookie") {
      continue;
    }
    const schema = isRecord(p.schema) ? p.schema : undefined;
    params.push({ name, in: location, required: p.required === true, schema });
  }
  return params;
}

function firstSuccessSchema(responses: Record<string, unknown>): OpenApiSchema | undefined {
  const codes = Object.keys(responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  const code = codes[0] ?? (isRecord(responses.default) ? "default" : undefined);
  if (!code) return undefined;
  const resp = responses[code];
  if (!isRecord(resp)) return undefined;
  return firstJsonSchema(isRecord(resp.content) ? resp.content : undefined);
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
  return actual === declared;
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
    if (schema.nullable === true || schema.type === "null") return issues;
    if (schema.type) issues.push({ path: at, message: `expected ${schema.type}, got null` });
    return issues;
  }

  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    issues.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    issues.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (schema.type && !matchesType(schema.type, value)) {
    issues.push({ path: at, message: `expected ${schema.type}, got ${typeOfValue(value)}` });
    return issues; // the shape checks below assume the declared type held
  }

  if (schema.type === "string" && typeof value === "string") {
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

  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
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

  if (schema.type === "array" && Array.isArray(value)) {
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
      if (!(req in value)) issues.push({ path: `${path}/${req}`, message: "is required" });
    }
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) issues.push(...validateValue(doc, propSchema, value[key], `${path}/${key}`));
    }
    const extra = schema.additionalProperties;
    if (extra === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) issues.push({ path: `${path}/${key}`, message: "is not an allowed property" });
      }
    } else if (isRecord(extra)) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) issues.push(...validateValue(doc, extra, value[key], `${path}/${key}`));
      }
    }
  }

  return issues;
}
