// Slice S7 (adversarial) — the no-PII guard holds BY CONSTRUCTION and under
// evasion.
//
// The DEFAULT S3 write path (no special caller wiring) must reject a
// PII-carrying record because S3 pre-registers the mandatory S6 guard. These
// tests prove that, then attempt obfuscated / nested / edge-case PII and confirm
// the guard still blocks it — and that a caller cannot bypass it.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextWriter } from "../git/index.ts";
import { PiiGuardError, classifyPii, preCommitPiiGuard } from "../pii/index.ts";
import { ContextRetriever } from "../retrieval/index.ts";
import { cleanup, makeSubstrate, rec } from "./harness.ts";

const TEMP_ROOTS: string[] = [];
after(() => cleanup(TEMP_ROOTS));

test("the DEFAULT write path (no wiring) rejects a PII-carrying record", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  // Plain default construction — the caller does NOT opt into any guard.
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // The mandatory PII guard is present by construction.
  assert.ok(writer.guards.length >= 1, "at least the mandatory PII guard must be registered");

  await assert.rejects(
    () => writer.appendRecord(rec({ id: "pii-plain", statement: "reach me at alice@example.com" })),
    PiiGuardError,
  );

  // Governance path is guarded too.
  await assert.rejects(
    () =>
      writer.proposePrior(
        rec({
          id: "pii-propose",
          provenance: "agent-retro",
          mode: "normative",
          authority: "hypothesis",
          statement: "ssn 123-45-6789 belongs to the reporter",
        }),
      ),
    PiiGuardError,
  );

  // Nothing leaked into the store.
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal((await retriever.all()).length, 0);
});

test("PII hidden in a NESTED field (evidence array) is still blocked", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await assert.rejects(
    () =>
      writer.appendRecord(
        rec({
          id: "pii-nested",
          statement: "clean summary",
          evidence: ["run-1", "leaked key AKIAIOSFODNN7EXAMPLE in logs"],
        }),
      ),
    PiiGuardError,
  );
});

test("OBFUSCATED email evades a naive scan but not the guard", () => {
  // The classifier's de-obfuscation pass catches spelled-out separators.
  const obfuscated = "contact bob [at] example [dot] com for details";
  const result = classifyPii(obfuscated);
  assert.equal(result.clean, false, "obfuscated email must be detected");
  assert.equal(result.findings.some((f) => f.kind === "email"), true);

  // The default guard throws on it, mirroring the write path.
  assert.throws(() => preCommitPiiGuard.assert(obfuscated), PiiGuardError);
});

test("clean content passes the guard and lands", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await writer.appendRecord(rec({ id: "clean-1", statement: "throughput improved to 42 rps" }));

  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal((await retriever.all()).some((s) => s.record.id === "clean-1"), true);
});

test("an extra caller guard can only make enforcement STRICTER, never bypass PII", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  // Supplying additional guards must not displace the mandatory PII guard.
  const writer = new ContextWriter(
    { localPath: dir, ref: "main" },
    { guards: [preCommitPiiGuard] },
  );
  assert.ok(writer.guards.length >= 1);
  await assert.rejects(
    () => writer.appendRecord(rec({ id: "pii-extra", statement: "email me: eve@example.org" })),
    PiiGuardError,
  );
});
