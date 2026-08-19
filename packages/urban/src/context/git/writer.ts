// Slice S3 (git/governance) — git-as-system-of-record WRITE + governance.
//
// Builds the write and governance layer on top of a resolved substrate handle
// (from S1), the validated record schema (from S2), and the mandatory PII guard
// (from S6). It does NOT re-implement clone/pull (S1), the record schema (S2),
// or the PII classifier/guard (S6) — it composes them.
//
// Governance model (git-only MVP, no external services):
//
//  - APPEND-VIA-COMMIT: a validated record is persisted as a commit on the base
//    branch (append-only provenance). Used for human/measured/instance records —
//    facts and human-authored priors that land directly.
//  - PR-GOVERNANCE: an `agent-retro` prior is a PROPOSAL, written as a BOT branch
//    (the git-only stand-in for a bot PR) that is NOT on the base branch until it
//    is MERGED. A merge == ratification. Because the S2 schema forbids
//    `agent-retro` from ever being `authoritative`, an unmerged (or even a
//    merged) agent-retro record can never present as a measured/authoritative
//    fact — governance decides only whether the *hypothesis* is accepted onto the
//    authoritative line, never whether it becomes a fact.
//  - CONCURRENCY: within a SINGLE ContextWriter instance, writes are serialised
//    on the shared working tree (see #queue) and each still lands on its own
//    uniquely-named branch, so interleaved calls never clobber each other and
//    disjoint records merge cleanly. This guarantee is PER-INSTANCE: two
//    ContextWriter instances (or separate processes) pointing at the SAME working
//    copy are not coordinated and can interleave checkouts/commits and corrupt the
//    tree — use a separate clone (or external locking) per concurrent writer.
//  - PII BY CONSTRUCTION: the mandatory S6 guard is pre-registered in the guard
//    registry and run before EVERY commit on the default code path. A caller that
//    supplies no special wiring still gets it, so a PII-carrying write is rejected
//    before it is committed.

import { randomUUID } from "node:crypto";
import type { PiiGuard } from "../pii/index.ts";
import {
  assertMemoryRecord,
  type MemoryProvenance,
  type MemoryRecord,
} from "../schema/index.ts";
import { PreCommitGuardRegistry } from "./guard-registry.ts";
import { LAYOUT_ROOT, recordRelativePath } from "./layout.ts";
import {
  type CommitAuthor,
  GitWriteSubstrate,
  type WriteSubstrate,
} from "./substrate.ts";

/** Thrown when a write violates the PR-governance rules of this layer. */
export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

/** The default author attributed to direct (human/measured/instance) appends. */
export const DEFAULT_WRITE_AUTHOR: CommitAuthor = {
  name: "nano-context",
  email: "context@nanobpm.local",
};

/** The bot author attributed to proposed priors and their ratifying merges. */
export const DEFAULT_BOT_AUTHOR: CommitAuthor = {
  name: "nano-context-bot",
  email: "context-bot@nanobpm.local",
};

/**
 * The single source of truth for the proposal (bot "PR") branch namespace.
 * `proposePrior` creates branches under it and `ratify` refuses to merge anything
 * outside it, so an arbitrary caller-named branch can never be ratified.
 */
export const PROPOSAL_BRANCH_PREFIX = "context/proposal/" as const;

/** The minimal resolved-handle shape the writer consumes (from S1). */
export interface ResolvedSubstrateHandle {
  readonly localPath: string;
  readonly ref: string;
}

/** Options for {@link ContextWriter}. All optional; the defaults are safe. */
export interface ContextWriterOptions {
  /** Override the write substrate (seam for a future mutable/PII backend). */
  readonly substrate?: WriteSubstrate;
  /**
   * ADDITIONAL pre-commit guards. The mandatory S6 PII guard is always present
   * (see {@link PreCommitGuardRegistry}); these can only make enforcement
   * stricter, never bypass it.
   */
  readonly guards?: readonly PiiGuard[];
  /**
   * The base branch records land on / are proposed against. Defaults to the
   * resolved substrate handle's `ref` (the S1-resolved branch), falling back to
   * the substrate's currently checked-out branch only when the handle carries no
   * ref.
   */
  readonly baseBranch?: string;
  /** Author for direct appends. Defaults to {@link DEFAULT_WRITE_AUTHOR}. */
  readonly author?: CommitAuthor;
  /** Author for proposed priors + merges. Defaults to {@link DEFAULT_BOT_AUTHOR}. */
  readonly botAuthor?: CommitAuthor;
}

/** The outcome of a direct append (ratified immediately on the base branch). */
export interface AppendResult {
  /** Substrate-relative path the record was written to (see the layout helper). */
  readonly path: string;
  /** The commit that persisted the record on its write branch. */
  readonly commit: string;
  /** The merge commit that landed it on the base branch. */
  readonly mergeCommit: string;
  /** The base branch the record now lives on. */
  readonly branch: string;
  /** Always `true`: a direct append is ratified on landing. */
  readonly ratified: true;
}

/**
 * The outcome of a proposed prior (a bot "PR"). The record lives on
 * {@link branch} only — it is NOT on the base branch until {@link ContextWriter.ratify}
 * merges it. Pass this handle back to `ratify` to accept the proposal.
 */
export interface ProposalResult {
  /** Substrate-relative path the record was written to on the proposal branch. */
  readonly path: string;
  /** The commit on the proposal branch that carries the proposed record. */
  readonly commit: string;
  /** The proposal (bot "PR") branch. Not merged until ratified. */
  readonly branch: string;
  /** The base branch this proposal targets. */
  readonly baseBranch: string;
  /** A stable id for the proposal (useful for logging/correlation). */
  readonly proposalId: string;
  /** Always `false` on creation: a proposal is an unratified hypothesis. */
  readonly ratified: false;
}

/** The outcome of ratifying (merging) a proposed prior onto the base branch. */
export interface RatifyResult {
  /** The merge commit that landed the proposal on the base branch. */
  readonly mergeCommit: string;
  /** The base branch the proposal was ratified onto. */
  readonly baseBranch: string;
}

/**
 * The git-as-system-of-record writer. One instance is bound to one resolved
 * substrate handle. Operations are serialised within the instance (a single
 * working copy has one working tree), so interleaved calls never race each
 * other's checkout/commit; each still lands on its own branch, so nothing is
 * clobbered.
 */
export class ContextWriter {
  readonly #substrate: WriteSubstrate;
  readonly #guards: PreCommitGuardRegistry;
  readonly #baseBranchOverride?: string;
  readonly #author: CommitAuthor;
  readonly #botAuthor: CommitAuthor;
  // A promise chain that serialises mutating operations on the shared working
  // tree so two in-flight writes cannot interleave their checkout/commit steps.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(handle: ResolvedSubstrateHandle, options: ContextWriterOptions = {}) {
    this.#substrate = options.substrate ?? new GitWriteSubstrate(handle.localPath);
    // The registry ALWAYS contains the mandatory PII guard; `guards` can only add.
    this.#guards = new PreCommitGuardRegistry(options.guards ?? []);
    this.#baseBranchOverride = options.baseBranch ?? (handle.ref || undefined);
    this.#author = options.author ?? DEFAULT_WRITE_AUTHOR;
    this.#botAuthor = options.botAuthor ?? DEFAULT_BOT_AUTHOR;
  }

  /** The pre-commit guards that run before every write (mandatory PII first). */
  get guards(): readonly PiiGuard[] {
    return this.#guards.guards;
  }

  /**
   * APPEND-VIA-COMMIT (direct, ratified-on-landing) write path for
   * human/measured/instance records. Validates the record against the S2 schema
   * (including the forgery-resistance invariants), runs the mandatory PII guard,
   * then commits it on a fresh write branch and merges it onto the base branch.
   *
   * `agent-retro` records are REJECTED here by construction: an agent proposal is
   * a hypothesis that must go through governance ({@link proposePrior} +
   * {@link ratify}), never a direct append. This is what stops an unratified
   * prior from landing on the authoritative line without a merge.
   */
  appendRecord(input: unknown): Promise<AppendResult> {
    return this.#serialise(async () => {
      const record = assertMemoryRecord(input);
      this.#assertDirectlyAppendable(record.provenance);
      // MANDATORY PII enforcement BY CONSTRUCTION — before ANY commit.
      this.#guards.assertAll(record);

      const base = await this.#resolveBaseBranch();
      const relPath = recordRelativePath(record);
      const writeBranch = this.#branchName("append", record.id);

      // A mid-operation failure (createBranch/write/commit/merge) must never leave
      // the SHARED working tree parked on a transient write branch with a
      // half-written record for the next serialised call to inherit; the `finally`
      // best-effort restores the resolved base and discards any residue.
      try {
        await this.#substrate.createBranch(writeBranch, base);
        await this.#substrate.writeRecordFile(relPath, serialiseRecord(record));
        const commit = await this.#substrate.stageAndCommit(
          `context(append): ${record.provenance}/${record.scope} ${record.id}`,
          this.#author,
        );

        await this.#substrate.checkout(base);
        const mergeCommit = await this.#substrate.mergeBranch(
          writeBranch,
          `context(append): land ${record.id} onto ${base}`,
          this.#author,
        );

        return { path: relPath, commit, mergeCommit, branch: base, ratified: true };
      } finally {
        await this.#restoreBase(base);
      }
    });
  }

  /**
   * PR-GOVERNANCE write path: write a record as a PROPOSED prior on a bot branch
   * (the git-only stand-in for a bot PR). The record is committed on its own
   * branch and left UNMERGED, so it is not on the base branch — an unratified
   * hypothesis. Ratify it with {@link ratify}.
   *
   * This is the mandatory path for `agent-retro` records and is available for any
   * record a caller wants to route through governance rather than land directly.
   * The mandatory PII guard runs here too, before the commit.
   */
  proposePrior(input: unknown): Promise<ProposalResult> {
    return this.#serialise(async () => {
      const record = assertMemoryRecord(input);
      // MANDATORY PII enforcement BY CONSTRUCTION — before ANY commit.
      this.#guards.assertAll(record);

      const base = await this.#resolveBaseBranch();
      const relPath = recordRelativePath(record);
      const proposalId = `${sanitizeRef(record.id)}-${randomUUID().slice(0, 8)}`;
      const proposalBranch = `${PROPOSAL_BRANCH_PREFIX}${proposalId}`;

      // As with `appendRecord`, a mid-operation failure must not strand the shared
      // working tree on the proposal branch; the `finally` restores the base. The
      // proposal COMMIT is preserved on its own branch (a hypothesis until
      // ratified) — restoring the base only moves the working tree off it, it does
      // not discard the committed proposal.
      try {
        await this.#substrate.createBranch(proposalBranch, base);
        await this.#substrate.writeRecordFile(relPath, serialiseRecord(record));
        const commit = await this.#substrate.stageAndCommit(
          `context(propose): ${record.provenance}/${record.scope} ${record.id} [hypothesis]`,
          this.#botAuthor,
        );

        return {
          path: relPath,
          commit,
          branch: proposalBranch,
          baseBranch: base,
          proposalId,
          ratified: false,
        };
      } finally {
        // Leave the proposal branch UNMERGED — restoring the base only checks the
        // working tree back onto it; the proposal stays an unratified hypothesis.
        await this.#restoreBase(base);
      }
    });
  }

  /**
   * Ratify a proposed prior by MERGING its bot branch onto the base branch. After
   * this the proposal's record is on the authoritative line. Ratification records
   * that the hypothesis was ACCEPTED; it does not (and cannot) upgrade an
   * `agent-retro` record's authority to `authoritative` — the S2 schema forbids
   * that, so the record remains an accepted hypothesis, never a forged fact.
   */
  ratify(proposal: ProposalResult): Promise<RatifyResult> {
    return this.#serialise(async () => {
      if (!(await this.#substrate.branchExists(proposal.branch))) {
        throw new GovernanceError(
          `cannot ratify: proposal branch ${proposal.branch} does not exist.`,
        );
      }
      // DEFENCE 1 — only a branch in the proposal namespace may be ratified, so a
      // caller cannot merge an arbitrary local branch onto the authoritative line.
      if (!proposal.branch.startsWith(PROPOSAL_BRANCH_PREFIX)) {
        throw new GovernanceError(
          `cannot ratify: ${proposal.branch} is not a proposal branch ` +
            `(expected a ${PROPOSAL_BRANCH_PREFIX}* branch).`,
        );
      }
      // DEFENCE 2 — the merge target is the writer's OWN resolved base branch, never
      // a caller-supplied one. `ProposalResult` is a plain object, so a consumer can
      // mutate `proposal.baseBranch` to steer the merge onto a different line than
      // this writer is bound to (undermining the "one resolved handle" contract).
      // Resolve the base ourselves and reject any proposal that targets a different
      // one; every downstream step (diff, checkout, merge) uses `base`, not the
      // untrusted `proposal.baseBranch`.
      const base = await this.#resolveBaseBranch();
      if (proposal.baseBranch !== base) {
        throw new GovernanceError(
          `cannot ratify: proposal targets base ${proposal.baseBranch}, but this ` +
            `writer is bound to ${base}. A proposal may only be ratified onto the ` +
            "base branch its writer resolved.",
        );
      }
      // DEFENCE 3 — the merge must introduce EXACTLY the one proposed record file
      // and nothing else. A proposal branch created/amended outside `proposePrior`
      // could carry extra files (more records, or content outside the record
      // layout) that a single-file re-read would never see; merging it would land
      // that content UNGUARDED. Bounding the diff to `[proposal.path]` makes the
      // file we re-guard below provably the ONLY candidate content being merged.
      const changed = await this.#substrate.diffPaths(base, proposal.branch);
      if (changed.length !== 1 || changed[0] !== proposal.path) {
        throw new GovernanceError(
          `cannot ratify: proposal branch ${proposal.branch} changes ` +
            `${JSON.stringify(changed)}, expected exactly ["${proposal.path}"]. ` +
            "A ratifying merge may introduce only its single proposed record file.",
        );
      }
      // The pre-commit guard is a NON-OPTIONAL step on EVERY write path (S6), and
      // a ratifying merge is a write onto the authoritative line. The proposal
      // branch content is untrusted here: re-read (at the ref, without mutating the
      // working tree), re-validate against the S2 schema, and re-run the mandatory
      // PII guard BEFORE merging, so a PII-carrying (or otherwise invalid) record
      // can never be ratified onto the base branch.
      const proposed = await this.#substrate.readFileAtRef(proposal.branch, proposal.path);
      const record = assertMemoryRecord(parseRecordJson(proposed, proposal.path));
      this.#guards.assertAll(record);
      // DEFENCE 4 — the on-disk path must be the record's canonical layout path, so
      // a record can never be ratified under a path that mismatches its validated
      // scope/scopeRef/id (which would make it invisible to layout-based retrieval).
      const canonical = recordRelativePath(record);
      if (proposal.path !== canonical) {
        throw new GovernanceError(
          `cannot ratify: proposal path ${proposal.path} does not match the ` +
            `record's canonical layout ${canonical}.`,
        );
      }

      await this.#substrate.checkout(base);
      // The merge commit message is derived from the GUARDED, schema-validated
      // `record.id` (re-read and re-guarded above), never the caller-controlled
      // `proposal.proposalId` on the plain-object handle. Interpolating the latter
      // would let a consumer inject unguarded content (PII, newlines) into the
      // commit message and bypass the mandatory PII guard, which only inspects
      // record content.
      const mergeCommit = await this.#substrate.mergeBranch(
        proposal.branch,
        `context(ratify): merge record ${record.id} onto ${base}`,
        this.#botAuthor,
      );
      return { mergeCommit, baseBranch: base };
    });
  }

  /**
   * `true` iff the proposal has been ratified (its commit is an ancestor of the
   * base branch). A never-ratified proposal reads back as `false`, so an unmerged
   * prior can never masquerade as a ratified one.
   */
  isRatified(proposal: ProposalResult): Promise<boolean> {
    return this.#serialise(async () => {
      // Bind the ancestry check to the writer's OWN resolved base, never the
      // caller-supplied `proposal.baseBranch`. That field is a plain-object handle
      // a consumer can mutate to any ref where `proposal.commit` happens to be an
      // ancestor, which would report an UNratified hypothesis as ratified. Reject a
      // retargeted proposal outright (same trust boundary as ratify's DEFENCE 2).
      const base = await this.#resolveBaseBranch();
      if (proposal.baseBranch !== base) {
        throw new GovernanceError(
          `cannot check ratification: proposal targets base ${proposal.baseBranch}, ` +
            `but this writer is bound to ${base}.`,
        );
      }
      return this.#substrate.isMerged(proposal.commit, base);
    });
  }

  #assertDirectlyAppendable(provenance: MemoryProvenance): void {
    if (provenance === "agent-retro") {
      throw new GovernanceError(
        "an 'agent-retro' prior is a hypothesis and must be routed through governance " +
          "(proposePrior + ratify), not appended directly. Merging the proposal ratifies it.",
      );
    }
  }

  async #resolveBaseBranch(): Promise<string> {
    return this.#baseBranchOverride ?? (await this.#substrate.currentBranch());
  }

  // Best-effort return of the shared working tree to `base`, discarding any
  // uncommitted/untracked residue under the record layout. Runs in the `finally`
  // of each mutating op so a failure never strands the tree on a transient branch;
  // swallows its own error so it can never mask the original operation's failure.
  async #restoreBase(base: string): Promise<void> {
    try {
      await this.#substrate.restoreClean(base, LAYOUT_ROOT);
    } catch {
      // best-effort only — never mask the original operation's error.
    }
  }

  #branchName(kind: string, id: string): string {
    return `context/${kind}/${sanitizeRef(id)}-${randomUUID().slice(0, 8)}`;
  }

  // Serialise mutating operations: chain each onto the previous so the shared
  // working tree is only ever touched by one operation at a time. Failures are
  // isolated — a rejected operation does not poison the queue for the next call.
  #serialise<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(op, op);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Serialise a record to deterministic, pretty-printed JSON with a trailing LF. */
export function serialiseRecord(record: MemoryRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parse proposal-branch JSON, surfacing malformed content as a GovernanceError. */
function parseRecordJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new GovernanceError(
      `cannot ratify: proposed record at ${path} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/** Reduce an id to a git-ref-safe branch segment (no `..`, spaces, or `~^:?*[`). */
function sanitizeRef(id: string): string {
  const cleaned = id
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "record" : cleaned;
}
