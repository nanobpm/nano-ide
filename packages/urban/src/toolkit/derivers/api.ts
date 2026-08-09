// Deriver: an OpenAPI document → `api-io.d.ts` (the endpoint type map) + `operations.ts` (the typed
// `defineOperation` wrapper). ADR 0058: the contract-first endpoint surface. This is the authoring
// half — per `operationId` it emits a `Request`/`Response` type from the operation's parameters,
// requestBody, and first success response, plus an `ApiOperationId` union — mirroring how
// `worker-io.d.ts` types `defineWorker` from the model (ADR 0033 §3). The runtime
// (`runtime/core/modules/api.ts`) is the matching half: it validates + routes from the SAME spec via
// the shared `openapi/spec.ts`, so types and runtime never drift.

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";
import {
  collectOperations,
  isObjectSchema,
  type OpenApiDoc,
  type OpenApiSchema,
  type OperationInfo,
  refName,
} from "../../openapi/spec.ts";

/** Filenames of the emitted artifacts (siblings of worker-io.d.ts in nano-generated/). */
export const API_BINDINGS_DTS = "api-io.d.ts";
export const API_BINDINGS_TS = "operations.ts";

/** A TS identifier form of an operationId (used for the per-op type names). */
function typeStem(operationId: string): string {
  const cleaned = operationId.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const pascal = cleaned
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
    .join("");
  return /^[A-Za-z_]/.test(pascal) ? pascal : `Op${pascal}`;
}

/** Render a JSON-Schema (OpenAPI subset) as a TS type expression. Local component `$ref`s render as
 *  their component name (emitted as named interfaces); unknown shapes fall back to `unknown`. */
export function schemaToTs(schema: OpenApiSchema | undefined, depth = 0): string {
  if (!schema || depth > 20) return "unknown";
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return name ? typeStem(name) : "unknown";
  }
  const nullable = schema.nullable === true;
  const wrap = (t: string) => (nullable ? `${t} | null` : t);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return wrap(schema.enum.map((v) => JSON.stringify(v)).join(" | "));
  }
  if (schema.const !== undefined) return wrap(JSON.stringify(schema.const));

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return wrap(schema.oneOf.map((s) => schemaToTs(s, depth + 1)).join(" | "));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return wrap(schema.anyOf.map((s) => schemaToTs(s, depth + 1)).join(" | "));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return wrap(schema.allOf.map((s) => schemaToTs(s, depth + 1)).join(" & "));
  }

  switch (schema.type) {
    case "string":
      return wrap("string");
    case "integer":
    case "number":
      return wrap("number");
    case "boolean":
      return wrap("boolean");
    case "null":
      return "null";
    case "array":
      return wrap(`Array<${schemaToTs(schema.items, depth + 1)}>`);
    case "object":
      return wrap(objectToTs(schema, depth));
    default:
      // No `type`: infer object-ness from object-only keywords (shared with the runtime
      // validator via isObjectSchema so types and validation agree); otherwise unknown.
      if (isObjectSchema(schema)) return wrap(objectToTs(schema, depth));
      return "unknown";
  }
}

function objectToTs(schema: OpenApiSchema, depth: number): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(props).map(([key, ps]) => {
    const opt = required.has(key) ? "" : "?";
    const doc = typeof ps.description === "string" ? ps.description.replace(/\*\//g, "*\\/") : undefined;
    const jsdoc = doc ? `/** ${doc} */ ` : "";
    return `${jsdoc}${JSON.stringify(key)}${opt}: ${schemaToTs(ps, depth + 1)}`;
  });
  const extra = schema.additionalProperties;
  if (extra && typeof extra === "object") {
    // TS requires every named property type to be assignable to the index signature. When the
    // schema also declares properties, a narrow index type (e.g. `number`) would make the emitted
    // type invalid (TS2411), so fall back to `unknown`; with no declared properties we can use the
    // precise additionalProperties type (the common "map" case).
    const hasProps = Object.keys(props).length > 0;
    entries.push(`[key: string]: ${hasProps ? "unknown" : schemaToTs(extra, depth + 1)}`);
  } else if (extra !== false) {
    // OpenAPI/JSON-Schema default: additional properties are allowed. Emit an index
    // signature so the emitted type isn't stricter than the runtime validator, which only
    // rejects extras when additionalProperties === false (otherwise excess-property errors
    // on object literals would reject bodies the runtime accepts).
    entries.push("[key: string]: unknown");
  }
  if (entries.length > 0) return `{ ${entries.join("; ")} }`;
  // No declared properties and additionalProperties: false → a closed, empty object.
  return "Record<string, never>";
}

/** The `params`/`query` object type for an operation, from its parameters (strings on the wire). */
function paramsTs(op: OperationInfo, where: "path" | "query"): string {
  const ps = op.parameters.filter((p) => p.in === where);
  if (ps.length === 0) return "{}";
  const fields = ps.map((p) => {
    const opt = p.required ? "" : "?";
    // Query values arrive as strings (or string[] for repeated keys); path params are single
    // strings. Optionality is carried by the `?` modifier — don't fold `undefined` into the
    // value type, or required query params would still accept undefined.
    const t = where === "query" ? "string | string[]" : "string";
    return `${JSON.stringify(p.name)}${opt}: ${t}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** Emit `api-io.d.ts`: named component types + per-operation Request/Response + the id union. */
export function emitApiBindings(doc: OpenApiDoc): string {
  const ops = collectOperations(doc);
  const components = doc.components?.schemas ?? {};

  const header =
    "// AUTO-GENERATED by @nanobpm/urban from the app's OpenAPI spec (ADR 0058).\n" +
    "// The endpoint type map: each operationId maps to its typed request (path/query params +\n" +
    "// JSON body) and success response, derived from the spec. Do not edit — regenerated from\n" +
    "// the spec; erased to plain JS at compile.\n" +
    "// eslint-disable\n\n";

  const componentDecls = Object.entries(components)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, schema]) => `export type ${typeStem(name)} = ${schemaToTs(schema)};`)
    .join("\n");

  const opDecls = ops
    .map((op) => {
      const stem = typeStem(op.operationId);
      const bodyType = op.requestBodySchema ? schemaToTs(op.requestBodySchema) : "undefined";
      // An optional (or absent) request body is passed to the delegate as `undefined` at runtime,
      // so mark it optional in the type rather than forcing handlers to treat it as always-present.
      const bodyOpt = op.requestBodyRequired ? "" : "?";
      const resp = op.responseSchema ? schemaToTs(op.responseSchema) : "unknown";
      const summary = op.summary ? `/** ${op.summary.replace(/\*\//g, "*\\/")} */\n` : "";
      return (
        `${summary}export interface ${stem}Request {\n` +
        `  params: ${paramsTs(op, "path")};\n` +
        `  query: ${paramsTs(op, "query")};\n` +
        `  body${bodyOpt}: ${bodyType};\n` +
        `}\n` +
        `export type ${stem}Response = ${resp};`
      );
    })
    .join("\n\n");

  const idUnion = ops.length > 0
    ? ops.map((o) => JSON.stringify(o.operationId)).join(" | ")
    : "never";

  const mapEntries = ops
    .map((op) => {
      const stem = typeStem(op.operationId);
      return `  ${JSON.stringify(op.operationId)}: { request: ${stem}Request; response: ${stem}Response };`;
    })
    .join("\n");

  return (
    header +
    (componentDecls ? `${componentDecls}\n\n` : "") +
    (opDecls ? `${opDecls}\n\n` : "") +
    `/** Every declared operationId (ADR 0058): the delegate key set. */\n` +
    `export type ApiOperationId = ${idUnion};\n\n` +
    `/** Request/response contract per operationId. */\n` +
    `export interface ApiOperations {\n${mapEntries}\n}\n`
  );
}

/** Emit `operations.ts`: the typed `defineOperation` wrapper, keyed by operationId (mirrors the
 *  generated typed `defineWorker`). Written verbatim (it never changes with the spec) — it only
 *  re-types the runtime's `defineOperation`. */
export function emitApiBindingsRuntime(): string {
  return (
    "// AUTO-GENERATED by @nanobpm/urban (ADR 0058): the typed `defineOperation`.\n" +
    "// Re-exports the operation SDK and overrides `defineOperation` with an operationId-keyed\n" +
    "// signature (the delegate's validated request + result typed from the spec). Erased to a\n" +
    "// pass-through at runtime. Do not edit.\n" +
    "// eslint-disable\n\n" +
    `import { defineOperation as defineOperationRaw } from "@nanobpm/urban";\n` +
    `import type { OperationHandler } from "@nanobpm/urban";\n` +
    `import type { ApiOperationId, ApiOperations } from "./${API_BINDINGS_DTS}";\n\n` +
    `type ReqFor<K extends ApiOperationId> = ApiOperations[K]["request"];\n` +
    `type ResFor<K extends ApiOperationId> = ApiOperations[K]["response"];\n\n` +
    `/**\n` +
    ` * Typed \`defineOperation\`: \`id\` is constrained to the spec's declared operationIds\n` +
    ` * (ADR 0058) so it autocompletes and rejects unknown ops, and the handler's request\n` +
    ` * (validated params/query/body) + result are typed from the operation's schemas.\n` +
    ` */\n` +
    `export function defineOperation<K extends ApiOperationId>(\n` +
    `  id: K,\n` +
    `  handler: OperationHandler<ReqFor<K>, ResFor<K>>,\n` +
    `): OperationHandler<ReqFor<K>, ResFor<K>> {\n` +
    `  return defineOperationRaw(id, handler);\n` +
    `}\n`
  );
}

/** Derive the api artifacts from a parsed OpenAPI document. */
export function deriveApi(doc: OpenApiDoc): DerivedArtifact[] {
  return [
    { path: `${GENERATED_DIR}/${API_BINDINGS_DTS}`, content: emitApiBindings(doc) },
    { path: `${GENERATED_DIR}/${API_BINDINGS_TS}`, content: emitApiBindingsRuntime() },
  ];
}

export const apiDeriver: Deriver<{ doc: OpenApiDoc }> = {
  id: "openapi->api-io",
  describe: "Derive api-io.d.ts (typed request/response per operationId) + the typed defineOperation.",
  derive: ({ doc }) => deriveApi(doc),
};
