// Slice S7 (adversarial) — GOVERNANCE can't be bypassed.
//
// A proposed prior is a bot "PR": it lives on its own branch and is NOT on the
// authoritative line until MERGED (ratified). These tests prove an unmerged
// proposal never acts as a ratified one, and that the ratify path refuses to be
// steered onto an arbitrary branch or base.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextWriter, GovernanceError } from "../git/index.ts";
import { ContextRetriever } from "../retrieval/index.ts";
import { cleanup, git, makeSubstrate, rec } from "./harness.ts";

const TEMP_ROOTS: string[] = [];
after(() => cleanup(TEMP_ROOTS));

function retro(id: string) {
  return rec({
    id,
    provenance: "agent-retro",
    mode: "normative",
    authority: "hypothesis",
    statement: `proposed prior ${id}`,
  });
}

test("an UNMERGED proposal is invisible on the authoritative line", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(retro("gov-1"));
  assert.equal(proposal.ratified, false);

  // Before ratifying, a reader on main sees nothing — the hypothesis is parked
  // on its own branch, not on the base line.
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal((await retriever.all()).some((s) => s.record.id === "gov-1"), false);

  // Only the merge ratifies it onto main.
  await writer.ratify(proposal);
  retriever.invalidate();
  assert.equal((await retriever.all()).some((s) => s.record.id === "gov-1"), true);
});

test("ratify refuses a branch outside the proposal namespace", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // A real, existing branch that is NOT a proposal branch.
  await git(dir, "branch", "sneaky-branch", "main");

  await assert.rejects(
    () =>
      writer.ratify({
        path: "whatever",
        commit: "deadbeef",
        branch: "sneaky-branch",
        baseBranch: "main",
        proposalId: "forged",
        ratified: false,
      }),
    GovernanceError,
  );
});

test("ratify refuses a proposal whose base was steered off the writer's own base", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(retro("gov-steer"));
  // ProposalResult is a plain object; a hostile caller mutates the target base.
  await assert.rejects(
    () => writer.ratify({ ...proposal, baseBranch: "some-other-branch" }),
    GovernanceError,
  );

  // The proposal is still unratified: main must NOT contain it.
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal((await retriever.all()).some((s) => s.record.id === "gov-steer"), false);
});

test("ratify refuses a non-existent proposal branch", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await assert.rejects(
    () =>
      writer.ratify({
        path: "p",
        commit: "c",
        branch: "context/proposal/does-not-exist",
        baseBranch: "main",
        proposalId: "ghost",
        ratified: false,
      }),
    GovernanceError,
  );
});
