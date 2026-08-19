// @nanobpm/urban/context/git — slice S3 (git substrate + PR-governance).
//
// The git-as-system-of-record WRITE + governance layer, built on top of a
// resolved substrate handle (S1), the validated record schema (S2), and the
// mandatory PII pre-commit guard (S6). It publishes three things downstream:
//
//  1. APPEND / GOVERNANCE — ContextWriter: append-via-commit for
//     human/measured/instance facts, and PR-governance (propose → ratify) for
//     agent-retro hypotheses, with the mandatory PII guard wired into EVERY write
//     path so PII is rejected before any commit, by construction.
//  2. PATH / NAMESPACE PARTITIONING — the layout helper (recordRelativePath,
//     recordDir, scopeDir, isRecordPath, LAYOUT_ROOT). S4 retrieval and the S6 CI
//     slice READ this exact layout, so it is exported as a stable seam.
//  3. THE WRITE SUBSTRATE SEAM — WriteSubstrate / GitWriteSubstrate: the write
//     path is abstracted over the substrate (not hard-wired to public git),
//     leaving room for a future PII/mutable backend, and the
//     PreCommitGuardRegistry that makes the PII guard non-bypassable.

export {
  LAYOUT_ROOT,
  RECORD_FILE_EXTENSION,
  UNSCOPED_BUCKET,
  isRecordPath,
  recordDir,
  recordRelativePath,
  sanitizeSegment,
  scopeDir,
} from "./layout.ts";

export { PreCommitGuardRegistry } from "./guard-registry.ts";

export {
  type CommitAuthor,
  GitWriteSubstrate,
  SubstrateWriteError,
  substratePath,
  type WriteSubstrate,
} from "./substrate.ts";

export {
  type AppendResult,
  ContextWriter,
  type ContextWriterOptions,
  DEFAULT_BOT_AUTHOR,
  DEFAULT_WRITE_AUTHOR,
  GovernanceError,
  type ProposalResult,
  type RatifyResult,
  type ResolvedSubstrateHandle,
  serialiseRecord,
} from "./writer.ts";
