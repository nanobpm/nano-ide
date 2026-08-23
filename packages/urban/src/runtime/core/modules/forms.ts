// Shared engine-form plumbing (ADR 0026, extended to the pages surface).
//
// The `taskInbox` surface pioneered rendering a user task's *engine-declared*
// form: resolve the task's `formKey`/`formId` via `EngineClient.getForm(...)`,
// render the returned form-js schema client-side, and post the entered values
// as the completion `variables`. The pages `dataGrid` engine-form detail (#457)
// needs the SAME two server seams — the `/api/form` resolution gate and the
// task-completion endpoint — so they live here ONCE and are wired by both
// `surfaces.ts` (taskInbox) and `pages.ts` (the grid detail). No fork: a single
// resolution gate, and the `host.ts` `presentFormIdentifier` presence rule stays
// the single source of truth for "was an identifier provided".

import type { EngineClient, HttpResponse } from "../host.ts";
import { presentFormIdentifier } from "../host.ts";
import { isRecord } from "../guards.ts";
import { json, noContent } from "../router.ts";

/**
 * The shared `/api/form` resolution gate. Rejects only when *neither* identifier
 * is present — presence follows getForm's canonical rule (`presentFormIdentifier`:
 * empty/whitespace = absent) so a whitespace-only `?formKey=   ` 400s here instead
 * of slipping past a raw truthiness check and returning a spurious 204. The raw
 * values are passed through unchanged — resolving a blank key to its `formId`
 * fallback is getForm's single responsibility. A form that can't be resolved
 * returns 204 so the client renders the no-form fallback rather than erroring.
 */
export async function resolveFormResponse(
  engine: Pick<EngineClient, "getForm">,
  formKey: string | undefined,
  formId: string | undefined,
): Promise<HttpResponse> {
  if (!presentFormIdentifier(formKey) && !presentFormIdentifier(formId))
    return json({ error: "formKey or formId required" }, 400);
  const form = await engine.getForm({ formKey, formId });
  if (!form) return noContent();
  return json(form);
}

/**
 * The shared user-task completion endpoint. Parses `{ userTaskKey, variables }`
 * from the request body and completes the task via `EngineClient.completeUserTask`.
 * A body that isn't a JSON object (`null`, a scalar, an array) 400s instead of
 * throwing a 500; a missing/blank `userTaskKey` 400s; a malformed body 400s; a
 * present but non-object `variables` (number, string, array, `null`) 400s so the
 * completion contract stays well-defined at this shared seam. Used by both the
 * taskInbox surface and the pages grid's engine-form detail so the completion
 * contract can't drift between them.
 */
export async function completeUserTaskResponse(
  engine: Pick<EngineClient, "completeUserTask">,
  bodyText: string,
): Promise<HttpResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText || "{}");
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!isRecord(parsed)) return json({ error: "invalid JSON body" }, 400);
  const { userTaskKey, variables } = parsed;
  if (typeof userTaskKey !== "string" || !userTaskKey)
    return json({ error: "userTaskKey required" }, 400);
  if (variables !== undefined && !isRecord(variables))
    return json({ error: "variables must be a JSON object" }, 400);
  await engine.completeUserTask(userTaskKey, variables);
  return json({ ok: true });
}
