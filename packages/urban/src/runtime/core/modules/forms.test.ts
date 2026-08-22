// The shared engine-form server seams (ADR 0026, #457): the /api/form resolution
// gate and the user-task completion, factored out of surfaces.ts so the taskInbox
// surface and the pages grid detail share ONE implementation. These tests pin the
// gate's contract directly (both callers depend on it identically).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineClient, FormSchema } from "../host.ts";
import { completeUserTaskResponse, resolveFormResponse } from "./forms.ts";

function formEngine(getForm: EngineClient["getForm"]): Pick<EngineClient, "getForm"> {
  return { getForm };
}

test("resolveFormResponse 400s when neither identifier is present (empty/whitespace = absent)", async () => {
  const engine = formEngine(async () => {
    throw new Error("getForm must not be called when no identifier is present");
  });
  for (const [formKey, formId] of [
    [undefined, undefined],
    ["", ""],
    ["   ", undefined],
    [undefined, "\t"],
  ] as const) {
    const res = await resolveFormResponse(engine, formKey, formId);
    assert.equal(res.status, 400);
  }
});

test("resolveFormResponse passes raw identifiers through to getForm and returns its schema", async () => {
  const seen: { formKey?: string; formId?: string }[] = [];
  const schema: FormSchema = { formKey: "form-1", schema: { components: [] } };
  const engine = formEngine(async (input) => {
    seen.push(input);
    return schema;
  });
  const res = await resolveFormResponse(engine, "form-1", undefined);
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.deepEqual(JSON.parse(res.body), schema);
  // A blank formKey is passed through unchanged so getForm can fall back to formId
  // (that fallback is getForm's single responsibility, not the gate's).
  await resolveFormResponse(engine, "", "the-form-id");
  assert.deepEqual(seen, [
    { formKey: "form-1", formId: undefined },
    { formKey: "", formId: "the-form-id" },
  ]);
});

test("resolveFormResponse 204s (no body) when getForm can't resolve a form", async () => {
  const res = await resolveFormResponse(formEngine(async () => null), "missing", undefined);
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
});

test("completeUserTaskResponse completes the task with the submitted variables", async () => {
  const calls: { key: string; variables?: Record<string, unknown> }[] = [];
  const engine: Pick<EngineClient, "completeUserTask"> = {
    async completeUserTask(key, variables) {
      calls.push({ key, variables });
    },
  };
  const res = await completeUserTaskResponse(engine, JSON.stringify({ userTaskKey: "ut-7", variables: { a: 1 } }));
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.deepEqual(calls, [{ key: "ut-7", variables: { a: 1 } }]);
});

test("completeUserTaskResponse 400s on a missing userTaskKey or malformed body — no completion attempted", async () => {
  let called = false;
  const engine: Pick<EngineClient, "completeUserTask"> = {
    async completeUserTask() {
      called = true;
    },
  };
  assert.equal((await completeUserTaskResponse(engine, JSON.stringify({ variables: {} }))).status, 400);
  assert.equal((await completeUserTaskResponse(engine, "{ not json")).status, 400);
  assert.equal(called, false);
});
