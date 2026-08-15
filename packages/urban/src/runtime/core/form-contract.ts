// The shared, transport-agnostic normalization glue for the form + user-task parts of
// the {@link EngineClient} contract. Both engine adapters — the live SDK/REST adapter
// (`engine/nanosdk.ts`, `SdkEngineClient`) and the in-process WASM test adapter
// (`@nanobpm/urban-testkit`, `WasmEngineClient`) — reproduce the same API-layer
// conveniences (form storage + `formId`→`formKey` resolution, form-schema parsing,
// user-task form linkage) on top of their own transport. Historically each adapter
// hand-mirrored these rules (with literal `// Mirror … exactly` comments), and that
// copy-paste drifted — e.g. a local `presentFormIdentifier` copy that trimmed for the
// emptiness check but returned the *untrimmed* value. Centralizing the rules here so
// both adapters call the *same* code removes that drift class (issue #252).

import { presentFormIdentifier } from "./host.ts";
import type { FormSchema } from "./host.ts";
import { isRecord } from "./guards.ts";

export { presentFormIdentifier };

/**
 * Presence-check a possibly-numeric identifier under the shared trim rule. The REST body may
 * carry a `formKey` as a number, so coerce it to a string; an empty or whitespace-only string
 * is *absent* (via {@link presentFormIdentifier}, which also trims). Any other type is absent.
 * This is the same trimming presence rule {@link resolveFormIdentifier} applies, so a blank
 * key can never be surfaced as an empty/whitespace value — the drift-bug class #252 targets.
 */
function presentKey(v: unknown): string | undefined {
  if (typeof v === "number") return presentFormIdentifier(String(v));
  if (typeof v === "string") return presentFormIdentifier(v);
  return undefined;
}

/**
 * Resolve which identifier addresses a form for {@link EngineClient.getForm}, applying the
 * contract's shared presence + preference rule: prefer a present `formKey`, else fall back
 * to a present `formId`; an empty/whitespace-only value is *absent* (via
 * {@link presentFormIdentifier}), so a blank `?formKey=` falls through to a valid `formId`
 * instead of short-circuiting to null. Returns `null` when neither identifier is present.
 *
 * `kind` distinguishes a resolved deploy key (`"key"`) from an authored form id (`"id"`),
 * which a key-addressed store (the WASM adapter) must itself resolve to a deploy key; a
 * key/id-agnostic backend (the REST gateway) can ignore `kind` and address by `value`.
 */
export function resolveFormIdentifier(
  input: { formKey?: string; formId?: string },
): { kind: "key" | "id"; value: string } | null {
  const key = presentFormIdentifier(input.formKey);
  if (key != null) return { kind: "key", value: key };
  const id = presentFormIdentifier(input.formId);
  if (id != null) return { kind: "id", value: id };
  return null;
}

/**
 * Parse a deployed form-js schema into the object the surface renders. The engine
 * serializes it as a JSON string, so parse it; tolerate an already-parsed object (an
 * in-memory/embedded engine). Returns `null` for anything that is neither a JSON object
 * string nor an object (which the caller treats as "no such form").
 */
export function parseFormSchema(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Assemble the {@link FormSchema} result with the contract's presence guards: a blank or
 * whitespace-only `formKey`/`formId`, or a non-numeric `version`, is omitted rather than
 * surfaced as an empty/garbage value. Identifiers are trimmed (the shared presence rule), so
 * a padded `formKey` never leaks whitespace; `formKey` is stringified (the REST body may carry
 * it as a number).
 */
export function buildFormSchema(parts: {
  schema: Record<string, unknown>;
  formKey?: unknown;
  formId?: unknown;
  version?: unknown;
}): FormSchema {
  const formKey = presentKey(parts.formKey);
  const formId = typeof parts.formId === "string" ? presentFormIdentifier(parts.formId) : undefined;
  return {
    schema: parts.schema,
    ...(formKey != null ? { formKey } : {}),
    ...(formId != null ? { formId } : {}),
    ...(typeof parts.version === "number" ? { version: parts.version } : {}),
  };
}

/**
 * Select a user task's form linkage from a raw engine record for
 * {@link EngineClient.searchUserTasks}, applying the contract's non-empty rule (a blank
 * `formKey`/`externalFormReference` is absent). The engine resolves a
 * `<zeebe:formDefinition formId="X" />` linkage to the latest deployed form's key at task
 * creation, so a resolved `formKey` (not a form id) is the linkage a task reports.
 *
 * A key-addressed engine that does *not* itself resolve that linkage (the WASM adapter)
 * can pass `resolveFormKeyByFormId` to map an authored `formId` on the task to the deploy
 * key; a backend that already resolved it (the REST gateway) omits the resolver, and the
 * authored-id path is simply not taken. A blank or whitespace-only `formKey`/`formId`/
 * `externalFormReference` is treated as absent (the shared trimming presence rule).
 */
export function pickFormLinkage(
  raw: Record<string, unknown>,
  resolveFormKeyByFormId?: (formId: string) => string | undefined,
): { formKey?: string; externalFormReference?: string } {
  const directKey = presentKey(raw.formKey);
  const authoredId = typeof raw.formId === "string" ? presentFormIdentifier(raw.formId) : undefined;
  const formKey =
    directKey ?? (authoredId && resolveFormKeyByFormId ? resolveFormKeyByFormId(authoredId) : undefined);
  const externalFormReference =
    typeof raw.externalFormReference === "string"
      ? presentFormIdentifier(raw.externalFormReference)
      : undefined;
  return {
    ...(formKey ? { formKey } : {}),
    ...(externalFormReference ? { externalFormReference } : {}),
  };
}
