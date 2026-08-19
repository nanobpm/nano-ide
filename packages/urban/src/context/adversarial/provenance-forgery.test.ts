// Slice S7 (adversarial) — PROVENANCE / AUTHORITY forgery resistance.
//
// The headline invariant of the whole layer is "hypothesis-never-fix": an
// unratified / agent-retrospective prior can never be REPRESENTED as a measured
// or authoritative fact. These tests attack that invariant directly — at the
// schema, at the write path, and after ratification — at EVERY scope.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextWriter } from "../git/index.ts";
import { ContextRetriever } from "../retrieval/index.ts";
import {
  MemoryRecordValidationError,
  type MemoryScope,
  SCOPE_LADDER,
  assertMemoryRecord,
  isAuthoritative,
  validateMemoryRecord,
} from "../schema/index.ts";
import { cleanup, makeSubstrate, rec } from "./harness.ts";

const TEMP_ROOTS: string[] = [];
after(() => cleanup(TEMP_ROOTS));

/** The forgery target: an agent-retro prior masquerading as an authoritative fact. */
function forgedAtScope(scope: MemoryScope): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: `forged-${scope}`,
    scope,
    mode: "empirical",
    provenance: "agent-retro",
    authority: "authoritative",
    statement: "a hypothesis laundered into a fact",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

test("schema: agent-retro can NEVER be authoritative — at every scope", () => {
  for (const scope of SCOPE_LADDER) {
    const result = validateMemoryRecord(forgedAtScope(scope));
    assert.equal(result.ok, false, `scope ${scope}: forged record must be rejected`);
    if (!result.ok) {
      assert.equal(
        result.errors.some((e) => e.code === "invariant-violation"),
        true,
        `scope ${scope}: expected an invariant-violation`,
      );
    }
    assert.throws(() => assertMemoryRecord(forgedAtScope(scope)), MemoryRecordValidationError);
  }
});

test("schema: no field permutation reaches authoritative via agent-retro", () => {
  // The ONLY provenances that may be authoritative are human/measured/instance.
  for (const mode of ["normative", "empirical"] as const) {
    const result = validateMemoryRecord({
      schemaVersion: 1,
      id: "x",
      scope: "repo",
      mode,
      provenance: "agent-retro",
      authority: "authoritative",
      statement: "s",
      createdAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(result.ok, false, `agent-retro/${mode}/authoritative must be rejected`);
  }
});

test("write path: a forged agent-retro-authoritative record cannot be persisted", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // Neither write path will commit it: append validates+rejects the invariant
  // (and also refuses agent-retro directly), propose validates+rejects it too.
  await assert.rejects(() => writer.appendRecord(forgedAtScope("epic")));
  await assert.rejects(() => writer.proposePrior(forgedAtScope("epic")));

  // And nothing landed in the store.
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const all = await retriever.all();
  assert.equal(all.some((s) => s.record.id === "forged-epic"), false);
  assert.equal(all.length, 0);
});

test("write path: agent-retro is refused on the DIRECT append path (must go via governance)", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  // A perfectly valid agent-retro hypothesis is still not directly appendable.
  await assert.rejects(() =>
    writer.appendRecord(
      rec({
        id: "retro-direct",
        provenance: "agent-retro",
        mode: "normative",
        authority: "hypothesis",
        statement: "prefer X over Y",
      }),
    ),
  );
});

test("ratification does NOT upgrade authority — the merged record stays a hypothesis", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    rec({
      id: "retro-1",
      provenance: "agent-retro",
      mode: "normative",
      authority: "hypothesis",
      statement: "a proposed prior",
    }),
  );
  await writer.ratify(proposal);

  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const found = (await retriever.all()).find((s) => s.record.id === "retro-1");
  assert.ok(found, "the ratified proposal is now on the authoritative line");
  // Ratified ≠ authoritative: the record is an ACCEPTED hypothesis, never a fact.
  assert.equal(found.record.authority, "hypothesis");
  assert.equal(found.record.provenance, "agent-retro");
  assert.equal(isAuthoritative(found.record), false);
});
