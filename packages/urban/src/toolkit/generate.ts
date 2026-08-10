// `urban gen`: the whole generation concern in one pass — derive artifacts (migrations, worker-I/O,
// code-first models, OpenAPI contracts + controller) AND scaffold the write-once handler stubs those
// artifacts reference (worker stubs from the model, operation-delegate stubs from the OpenAPI spec).
//
// This composes the pure derivation (`runGen`, gen.ts) with the write-once scaffolders (scaffold.ts)
// WITHOUT a cycle: scaffold.ts already depends on gen.ts, so this leaf module depends on both and
// neither depends back. Scaffolding is write-once (an existing, human-owned stub is never clobbered),
// so folding it into `gen` is idempotent. `--check` writes nothing: a missing stub surfaces in
// `missingStubs` exactly like a drifted artifact surfaces in `drift`, so CI fails when a stub the
// generated controller imports isn't committed.

import type { GenOptions, GenResult } from "./gen.ts";
import { runGen } from "./gen.ts";
import type { OperationStubOutcome, StubOutcome } from "./scaffold.ts";
import { scaffoldOperations, scaffoldWorkers } from "./scaffold.ts";
import type { StubManifestEntry } from "./scaffold/workers.ts";

export interface GenerateResult extends GenResult {
  /** Worker-stub scaffolding outcomes (created / kept / would-create). */
  workerStubs: StubOutcome[];
  /** Operation-delegate scaffolding outcomes (created / kept / would-create). */
  operationStubs: OperationStubOutcome[];
  /** Worker manifest entries wired into `workers[]` (write mode only). */
  wiredWorkers: StubManifestEntry[];
  /** True when `workers[]` was patched (write mode, unwired workers present). */
  manifestPatched: boolean;
  /**
   * App-relative paths of stubs that would be created — the scaffolding equivalent of `drift`.
   * Populated in `check` mode (nothing is written); a caller should fail CI when non-empty.
   */
  missingStubs: string[];
}

/**
 * Derive artifacts and scaffold the write-once handler stubs they reference, in one pass.
 * In `check` mode nothing is written and any would-be-created stub is reported in `missingStubs`.
 * Scaffolding is skipped when derivation is `incomplete` (never scaffold from a half-derived model);
 * the caller reports the derivation failure first.
 */
export async function generate(opts: GenOptions & { check?: boolean }): Promise<GenerateResult> {
  const res = await runGen(opts);

  const empty: GenerateResult = {
    ...res,
    workerStubs: [],
    operationStubs: [],
    wiredWorkers: [],
    manifestPatched: false,
    missingStubs: [],
  };
  if (res.incomplete) return empty;

  const write = !opts.check;
  const scaffoldOpts = { root: opts.root, io: opts.io, manifestFile: opts.manifestFile, write };
  const workers = await scaffoldWorkers(scaffoldOpts);
  const operations = await scaffoldOperations(scaffoldOpts);

  const missingStubs = [
    ...workers.outcomes.filter((o) => o.status === "would-create").map((o) => o.handlerPath),
    ...operations.outcomes.filter((o) => o.status === "would-create").map((o) => o.handlerPath),
  ];

  return {
    ...res,
    workerStubs: workers.outcomes,
    operationStubs: operations.outcomes,
    wiredWorkers: workers.wired,
    manifestPatched: workers.manifestPatched,
    missingStubs,
  };
}
