// Deriver: an OpenAPI document → `api-io.d.ts` (the endpoint type map) + `operations.ts` (the typed
// `defineOperation` wrapper). ADR 0058: the contract-first endpoint surface. This is the authoring
// half — per `operationId` it emits a `Request`/`Response` type from the operation's parameters,
// requestBody, and response (a union of every documented JSON response body), plus an
// `ApiOperationId` union — mirroring how
// `worker-io.d.ts` types `defineWorker` from the model (ADR 0033 §3). The runtime
// (`runtime/core/modules/api.ts`) is the matching half: it validates + routes from the SAME spec via
// the shared `openapi/spec.ts`, so types and runtime never drift.

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";
import { DEFAULT_OPERATIONS_DIR, normalizeApiDir } from "../api-dir.ts";
import {
  collectOperations,
  assertUniqueOperationIds,
  isObjectSchema,
  type OpenApiDoc,
  type OpenApiSchema,
  type OperationInfo,
  refName,
} from "../../openapi/spec.ts";

/** Filenames of the emitted artifacts (siblings of worker-io.d.ts in nano-generated/). */
export const API_BINDINGS_DTS = "api-io.d.ts";
export const API_BINDINGS_TS = "operations.ts";
/** The generated delegate registry: statically imports every operation delegate and asserts the
 *  complete, correctly-typed set via `satisfies` — so a missing/mismatched/orphan delegate fails
 *  `tsc` (ADR 0059). The runtime dispatches through this map instead of per-op path imports. */
export const API_CONTROLLER_TS = "controller.ts";

export { DEFAULT_OPERATIONS_DIR };


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

/** The `params`/`query` object type for an operation, from its parameters. Values are coerced to
 *  their declared schema type before the delegate receives them (the runtime coerces + validates,
 *  then forwards the coerced value), so a param's type is its schema type — not the raw wire string.
 *  A parameter with no schema, or ANY parameter of an ejected operation (whose runtime skips
 *  coercion/validation and hands the delegate the raw request), keeps the raw wire type (`string`,
 *  or `string | string[]` for query). */
function paramsTs(op: OperationInfo, where: "path" | "query"): string {
  const ps = op.parameters.filter((p) => p.in === where);
  if (ps.length === 0) return "{}";
  const rawWire = where === "query" ? "string | string[]" : "string";
  const fields = ps.map((p) => {
    const opt = p.required ? "" : "?";
    // Coerced to the schema type (number/boolean/array/enum/…); optionality is carried by the `?`
    // modifier — don't fold `undefined` into the value type, or required params would still accept
    // undefined. Schemaless params, and every param of an ejected op, fall back to the raw wire type.
    const t = op.eject || !p.schema ? rawWire : schemaToTs(p.schema);
    return `${JSON.stringify(p.name)}${opt}: ${t}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** Emit `api-io.d.ts`: named component types + per-operation Request/Response + the id union. */
export function emitApiBindings(doc: OpenApiDoc): string {
  const ops = collectOperations(doc);
  const components = doc.components?.schemas ?? {};

  // Fail-closed on TypeScript name collisions: typeStem is lossy (non-alphanumerics collapse), so
  // distinct component/operation names ("get-invoice" vs "get_invoice") can map to the same TS
  // identifier and emit duplicate declarations that break typechecking. Surface it here (where
  // `urban gen`/`urban check` reports it) rather than shipping broken generated types.
  const emittedTypeNames = new Map<string, string>();
  const claimTypeName = (typeName: string, source: string): void => {
    const prior = emittedTypeNames.get(typeName);
    if (prior !== undefined) {
      throw new Error(
        `OpenAPI spec produces a duplicate TypeScript type "${typeName}" from ${prior} and ${source} ` +
          `— their names collapse to the same identifier; rename one to disambiguate (ADR 0058).`,
      );
    }
    emittedTypeNames.set(typeName, source);
  };
  for (const name of Object.keys(components)) {
    claimTypeName(typeStem(name), `component schema "${name}"`);
  }
  for (const op of ops) {
    claimTypeName(`${typeStem(op.operationId)}Request`, `operationId "${op.operationId}"`);
    claimTypeName(`${typeStem(op.operationId)}Response`, `operationId "${op.operationId}"`);
  }

  const header =
    "// AUTO-GENERATED by @nanobpm/urban from the app's OpenAPI spec (ADR 0058).\n" +
    "// The endpoint type map: each operationId maps to its typed request (coerced path/query params\n" +
    "// + JSON body) and response (a union of every documented JSON response body), derived from the\n" +
    "// spec. Do not edit — regenerated from\n" +
    "// the spec; erased to plain JS at compile.\n" +
    "// eslint-disable\n\n";

  const componentDecls = Object.entries(components)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, schema]) => `export type ${typeStem(name)} = ${schemaToTs(schema)};`)
    .join("\n");

  const opDecls = ops
    .map((op) => {
      const stem = typeStem(op.operationId);
      // An ejected operation (`x-urban-eject`) bypasses the generated coercion/validation — its
      // delegate reads the raw request — so its input is NOT schema-shaped at runtime: params/query
      // stay raw wire types and the body is unvalidated (`unknown`). Typing it by the schema would
      // claim guarantees the runtime doesn't make. (Whole-surface `api.eject` is a manifest concern
      // the deriver can't see; that exception is documented in ADR 0059.)
      // With a schema → the typed body. Required but no JSON schema → `unknown` (a body IS
      // required at runtime, just of an unknown shape). Otherwise (optional, absent) → `undefined`.
      const bodyType = op.eject
        ? "unknown"
        : op.requestBodySchema
          ? schemaToTs(op.requestBodySchema)
          : op.requestBodyRequired
            ? "unknown"
            : "undefined";
      // An optional (or absent) request body is passed to the delegate as `undefined` at runtime,
      // so mark it optional in the type rather than forcing handlers to treat it as always-present.
      const bodyOpt = op.requestBodyRequired ? "" : "?";
      // Response type: a union of every documented JSON response body (success + errors), so a
      // handler that returns a documented error body typechecks against its operation's response
      // type. Deduped (identical schemas collapse), stable order. No documented JSON body → unknown.
      const respSeen = new Set<string>();
      const respParts = op.responseSchemas
        .map((e) => schemaToTs(e.schema))
        .filter((t) => (respSeen.has(t) ? false : (respSeen.add(t), true)));
      const resp = respParts.length > 0 ? respParts.join(" | ") : "unknown";
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

/** Normalize an `api.dir` to a clean relative segment (see `normalizeApiDir`); rejects absolute
 *  paths and `..` segments so the generated import paths stay app-relative and can't drift. */
function normalizeOperationsDir(dir: string): string {
  return normalizeApiDir(dir);
}

/**
 * Emit `controller.ts`: the generated delegate registry (ADR 0059). It statically imports every
 * operation delegate (`<dir>/<operationId>.ts`) and asserts the whole set against the spec-derived
 * contract with a single `satisfies { [K in ApiOperationId]: OperationHandler<ReqFor<K>, ResFor<K>> }`.
 * That one assertion gives four compile-time drift guarantees, all surfaced by `tsc`:
 *   • a missing delegate file            → the static `import` fails ("Cannot find module");
 *   • an op in the spec, missing here     → the mapped type requires key `K` ("Property is missing");
 *   • a delegate with the wrong signature → not assignable to `OperationHandler<Req, Res>`;
 *   • an orphan delegate (no spec op)     → an excess property vs the mapped type.
 * The runtime imports this ONE barrel and dispatches via `operations[operationId]`, so existing
 * endpoints cannot drift from the contract. Delegates are keyed by their real operationId; the
 * import binding is index-based (`op0`, `op1`, …) because an operationId is a safe path segment but
 * not necessarily a valid TS identifier. Requires each delegate to be a default export.
 */
export function emitApiController(doc: OpenApiDoc, operationsDir: string = DEFAULT_OPERATIONS_DIR): string {
  assertUniqueOperationIds(doc);
  const ops = collectOperations(doc);
  const dir = normalizeOperationsDir(operationsDir);

  const header =
    "// AUTO-GENERATED by @nanobpm/urban from the app's OpenAPI spec (ADR 0059): the delegate\n" +
    "// registry. Statically imports every operation delegate and asserts the complete, correctly-\n" +
    "// typed set via `satisfies` — a missing, mismatched, or orphan delegate fails `tsc`. The\n" +
    "// runtime dispatches through this map, so endpoints cannot drift from the spec. Do not edit —\n" +
    "// regenerated from the spec.\n" +
    "// eslint-disable\n\n";

  const typeImports =
    `import type { OperationHandler } from "@nanobpm/urban";\n` +
    `import type { ApiOperationId, ApiOperations } from "./${API_BINDINGS_DTS}";\n`;

  const delegateImports = ops
    .map((op, i) => `import op${i} from ${JSON.stringify(`../${dir}/${op.operationId}.ts`)};`)
    .join("\n");

  const mapEntries = ops.map((op, i) => `  ${JSON.stringify(op.operationId)}: op${i},`).join("\n");

  return (
    header +
    typeImports +
    (delegateImports ? `${delegateImports}\n` : "") +
    `\n` +
    `type ReqFor<K extends ApiOperationId> = ApiOperations[K]["request"];\n` +
    `type ResFor<K extends ApiOperationId> = ApiOperations[K]["response"];\n\n` +
    `/** Every operationId → its default-exported delegate. The \`satisfies\` clause makes \`tsc\`\n` +
    ` *  reject a missing, wrongly-typed, or orphan delegate (ADR 0059). */\n` +
    `export const operations = {\n${mapEntries}${mapEntries ? "\n" : ""}} satisfies {\n` +
    `  [K in ApiOperationId]: OperationHandler<ReqFor<K>, ResFor<K>>;\n` +
    `};\n`
  );
}

/** Derive the api artifacts from a parsed OpenAPI document. `operationsDir` is the manifest's
 *  `api.dir` (default `operations/`) — the controller's static delegate imports resolve into it. */
export function deriveApi(doc: OpenApiDoc, operationsDir: string = DEFAULT_OPERATIONS_DIR): DerivedArtifact[] {
  return [
    { path: `${GENERATED_DIR}/${API_BINDINGS_DTS}`, content: emitApiBindings(doc) },
    { path: `${GENERATED_DIR}/${API_BINDINGS_TS}`, content: emitApiBindingsRuntime() },
    { path: `${GENERATED_DIR}/${API_CONTROLLER_TS}`, content: emitApiController(doc, operationsDir) },
  ];
}

export const apiDeriver: Deriver<{ doc: OpenApiDoc; operationsDir?: string }> = {
  id: "openapi->api-io",
  describe:
    "Derive api-io.d.ts (typed request/response per operationId) + the typed defineOperation + the delegate registry.",
  derive: ({ doc, operationsDir }) => deriveApi(doc, operationsDir),
};
