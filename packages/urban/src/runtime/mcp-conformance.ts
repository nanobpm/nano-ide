// Real-spec MCP projection conformance guard (ADR 0067 · epic nanobpm/nano-ide#501, P2 #504).
//
// WHY THIS EXISTS
// The `check:mcp` parity guard exercises the projection's branches on a MINIMAL SYNTHETIC document
// (`mcp-parity.fixture.yaml`). That is exactly why the `$ref`-body defect shipped: the fixture never
// contained a `$ref`-bodied operation, while a real consumer app's `openapi.yaml` (nano-workforce,
// ADR 0067's first consumer) does. This guard closes that gap — it projects the projection over
// VENDORED, pinned, REAL consumer specs and asserts, for every projected (non-`x-mcp`-excluded)
// tool, the two properties the fix established:
//
//   - P0 (#502) — the tool's `inputSchema` is SELF-CONTAINED: no unresolved `$ref` (a client cannot
//     follow `#/components/...` outside the source document) and an explicit `type` on `body`.
//   - P1 (#503) — an object/array body ROUND-TRIPS through the real transport: an object argument
//     reaches the door as an object, and a pre-encoded JSON-string body is parsed once, never
//     double-encoded into a quoted string the door would reject.
//
// It reuses the EXACT projection + transport code both properties landed in (`toolInputSchema` /
// `findToolSchemaViolations` from `openapi/spec.ts`, and `normalizeBodyArg` from `mcp.ts`) rather
// than reimplementing a second, driftable copy (ADR 0053) — so a regression in either surface is
// caught here over a real spec, not discovered by a client. It needs NO running instance: the
// vendored file is projected directly.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectOperations,
  findToolSchemaViolations,
  type OpenApiDoc,
  type OperationInfo,
  parseSpec,
  toolInputSchema,
} from "../openapi/spec.ts";
import { effectiveRequestBodySchema, normalizeBodyArg, structuredBodyKind } from "./core/modules/mcp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = resolve(HERE, "../openapi/consumer-specs");

/** A vendored, pinned consumer OpenAPI spec the MCP projection is held to. Pinned to a specific
 *  commit so the guard is deterministic and offline (no live-instance dependency). The `ref` here is
 *  the single in-code source of truth for the pin — `mcp-conformance.test.ts` asserts it is a full
 *  40-hex commit SHA (so a mutable branch/tag ref can't make the guard non-deterministic), and
 *  `consumer-specs/README.md` documents the same commit. The test does not verify that `ref` matches
 *  the vendored bytes' provenance, so keep code, README, and bytes in sync when refreshing a pin. */
export interface ConsumerSpec {
  /** Short label used in violation messages, e.g. "nano-workforce". */
  label: string;
  /** Source repository the spec was vendored from, `owner/repo`. */
  repo: string;
  /** The commit SHA the vendored file is pinned to. */
  ref: string;
  /** Absolute path to the vendored `openapi.yaml`. */
  file: string;
}

/** The conformance corpus: real hosted-app specs, pinned. nano-workforce first (ADR 0067's first
 *  consumer, where the `$ref`-body mismatch surfaced). Add further consumer specs here as they
 *  adopt the projection. */
export const CONSUMER_SPECS: ConsumerSpec[] = [
  {
    label: "nano-workforce",
    repo: "nanobpm/nano-workforce",
    ref: "2018020a290c2f416e703e3584b27f92ccf27753",
    file: resolve(SPECS_DIR, "nano-workforce.openapi.yaml"),
  },
];

/** The transport normalizer the round-trip property is checked against — the real
 *  {@link normalizeBodyArg} in production, injectable so a test can prove a REINTRODUCED
 *  double-encoding path (a normalizer that leaves a pre-encoded string body a string) fails the
 *  guard. */
export type BodyNormalizer = (
  op: OperationInfo,
  args: Record<string, unknown>,
  doc: OpenApiDoc | undefined,
) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a value is the structured JSON shape the operation declares — an object for an `"object"`
 *  body, an array for an `"array"` body. Used to assert a body reaches the door as the right shape
 *  (not a JSON string, not a scalar). */
function isKind(value: unknown, kind: "object" | "array"): boolean {
  if (kind === "array") return Array.isArray(value);
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The transport round-trip property (P1) for one structured-body operation, checked against the
 *  real {@link normalizeBodyArg}. A representative empty instance of the declared shape must reach
 *  the door as that shape both when the client sends it as a value AND when the client sends it
 *  pre-encoded as a JSON string — the latter is what catches a reintroduced double-encoding path. */
function checkBodyRoundTrip(
  label: string,
  op: OperationInfo,
  kind: "object" | "array",
  doc: OpenApiDoc,
  normalizeBody: BodyNormalizer,
): string[] {
  const violations: string[] = [];
  const sample: unknown = kind === "array" ? [] : {};

  // (1) An object/array argument passes through the transport as that structured value.
  const asValue = normalizeBody(op, { body: sample }, doc);
  if (!asValue.ok) {
    violations.push(`${label}: ${op.operationId}: object-body argument rejected by transport: ${asValue.error}`);
  } else if (!isKind(asValue.args.body, kind)) {
    violations.push(
      `${label}: ${op.operationId}: object-body argument did not reach the door as a JSON ${kind}`,
    );
  }

  // (2) A pre-encoded JSON string round-trips to the structured value — NOT a double-encoded string.
  const asString = normalizeBody(op, { body: JSON.stringify(sample) }, doc);
  if (!asString.ok) {
    violations.push(
      `${label}: ${op.operationId}: pre-encoded JSON-string body rejected by transport: ${asString.error}`,
    );
  } else if (!isKind(asString.args.body, kind)) {
    violations.push(
      `${label}: ${op.operationId}: pre-encoded JSON-string body did not round-trip to a JSON ${kind} ` +
        "(a double-encoding path was reintroduced)",
    );
  }

  return violations;
}

/** Every conformance violation the projection would advertise for one spec document. Empty means
 *  every projected tool is self-contained (P0) and every object/array body round-trips faithfully
 *  through the real transport (P1). `normalizeBody` is injectable for negative tests; production uses
 *  the real {@link normalizeBodyArg}. */
export function findSpecConformanceViolations(
  label: string,
  doc: OpenApiDoc,
  normalizeBody: BodyNormalizer = normalizeBodyArg,
): string[] {
  let ops: OperationInfo[];
  try {
    // `collectOperations` deep-resolves each projected op's `$ref`s and throws loudly on a cyclic or
    // unresolvable ref — a spec that cannot project a self-contained schema fails HERE.
    ops = collectOperations(doc);
  } catch (e) {
    return [`${label}: projection failed (unresolvable or cyclic $ref?): ${describe(e)}`];
  }

  const violations: string[] = [];
  for (const op of ops) {
    if (op.mcpExcluded) continue;

    // P0: the projected input schema must be self-contained (no `$ref`, `body` explicitly typed).
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = toolInputSchema(op);
    } catch (e) {
      violations.push(`${label}: ${op.operationId}: input schema could not be resolved: ${describe(e)}`);
      continue;
    }
    for (const v of findToolSchemaViolations(op.operationId, inputSchema)) {
      violations.push(`${label}: ${v}`);
    }

    // P1: an object/array body must round-trip through the real transport.
    const kind = structuredBodyKind(effectiveRequestBodySchema(op, doc));
    if (kind) {
      violations.push(...checkBodyRoundTrip(label, op, kind, doc, normalizeBody));
    }
  }
  return violations;
}

/** Parse a vendored consumer spec from disk into an {@link OpenApiDoc}. */
export function loadConsumerSpec(spec: ConsumerSpec): OpenApiDoc {
  return parseSpec(readFileSync(spec.file, "utf8"));
}

/** One consumer spec's conformance outcome — its label and every violation (empty when it conforms).
 *  A spec whose FILE cannot be read/parsed surfaces as a single violation rather than throwing, so
 *  the guard reports it uniformly. */
export interface SpecConformanceResult {
  label: string;
  violations: string[];
}

/** Run the conformance guard over the whole {@link CONSUMER_SPECS} corpus (or an injected set). Each
 *  spec is loaded and projected independently so one broken spec does not mask the others. */
export function runConsumerConformance(specs: readonly ConsumerSpec[] = CONSUMER_SPECS): SpecConformanceResult[] {
  return specs.map((spec) => {
    let doc: OpenApiDoc;
    try {
      doc = loadConsumerSpec(spec);
    } catch (e) {
      return { label: spec.label, violations: [`${spec.label}: cannot load ${spec.file}: ${describe(e)}`] };
    }
    return { label: spec.label, violations: findSpecConformanceViolations(spec.label, doc) };
  });
}
