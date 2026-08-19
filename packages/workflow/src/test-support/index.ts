// @nanobpm/workflow/test-support — the DERIVATION-PARITY HARNESS (the oracle).
//
// This is the reusable test-support surface S1–S6 (epic #314) import to assert
// their derived flows against the hand-authored golden `.bpmn` models vendored in
// `packages/workflow/test/fixtures/nwf/`. It ships as the package subpath export
// `@nanobpm/workflow/test-support`:
//
//   import {
//     normalize,
//     assertDerivationParity,
//     deploySmoke,
//   } from "@nanobpm/workflow/test-support";
//
// PUBLIC SURFACE
// ─────────────────────────────────────────────────────────────────────────────
//
//   normalize(bpmnXml: string): CanonicalModel
//     Strip DI (`bpmndi:BPMNDiagram` layout) and canonicalize element ids, child
//     ordering, and sequence-flow ids so only SEMANTIC structure remains. Returns
//     a `CanonicalModel` — three sorted multisets: `nodes` (flow nodes with their
//     type + definition + edge-degree signature), `flows` (sequence, attach, and
//     containment edges by endpoint), and `messages` (each subscribed message's
//     full definition — name plus `zeebe:subscription correlationKey` and
//     `zeebe:properties` envelope, so correlationKey/envelope differences count).
//     Two models mean the same thing iff their `CanonicalModel`s are equal.
//
//   assertDerivationParity(derived, goldenBpmnPath): void
//     `derived` is a `DeclarativeFlow` (its BPMN is derived for you) or derived
//     BPMN XML. Normalizes both it and the golden at `goldenBpmnPath` and asserts
//     structural equality over flow nodes, sequence flows, message subscriptions,
//     and timer/boundary definitions — throwing a legible red/green structural
//     diff on mismatch.
//
//   deploySmoke(derivedModel, opts?): Promise<DeploySmokeResult>
//     Deploy the derived model to the wasm/live engine and assert acceptance.
//     Supply `{ client }`, `{ baseUrl }`, or set `WORKFLOW_GATEWAY_URL`; with no
//     engine reachable it resolves `{ skipped: true }` (never throws) so unit-only
//     CI stays green, and throws only when a reachable engine REJECTS the model.
//
// LOWER-LEVEL HELPERS (for custom assertions):
//   modelsEqual(a, b): boolean          — structural equality predicate.
//   diffModels(expected, actual): string — the red/green diff ("" when equal).
//   parseXml / localName                 — the dependency-free XML reader.

export { normalize } from "./normalize.js";
export type { CanonicalModel } from "./normalize.js";
export { assertDerivationParity, deploySmoke } from "./parity.js";
export type { DerivedInput, DeploySmokeOptions, DeploySmokeResult } from "./parity.js";
export { diffModels, modelsEqual } from "./diff.js";
export { parseXml, localName } from "./xml.js";
export type { XmlElement } from "./xml.js";
// The internal builder invariant guard, exposed for the fail-fast guard test.
export { isFlowBuilder, assemblyFailureMessage } from "../declarative.js";
