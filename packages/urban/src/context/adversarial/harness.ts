// Slice S7 (adversarial) — shared test harness.
//
// This module is NOT a test (no `*.test.ts` suffix, so `node --test` ignores it)
// and NOT part of the published surface (the top barrel never re-exports the
// adversarial slice). It only provides the local temp-git-substrate helpers the
// adversarial suites drive S3's REAL write path through. Nothing here touches the
// network or any external service.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hardenedGitArgs } from "../binding/git-backend.ts";
import type { MemoryRecord } from "../schema/index.ts";

const execFileAsync = promisify(execFile);

/**
 * Run a git command in `cwd`, returning trimmed stdout. Every invocation is
 * routed through {@link hardenedGitArgs} (the repo's single source of truth for
 * `core.hooksPath=/dev/null`), so `init`/`commit`/`checkout` can never execute a
 * hook from global templates or local config — keeping the harness deterministic
 * and closing the CI code-execution vector.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", hardenedGitArgs(args), { cwd });
  return stdout.trim();
}

/**
 * Create a fresh temp git repo with a single seed commit on `main`, register it
 * for cleanup in `roots`, and return its absolute path. This stands in for the
 * local working copy S1 resolves a binding to — the substrate S3 writes and S4
 * reads.
 */
export async function makeSubstrate(roots: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s7-substrate-"));
  roots.push(dir);
  await git(dir, "init");
  await writeFile(join(dir, "README.md"), "# context substrate\n", "utf8");
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=seed",
    "-c",
    "user.email=seed@nanobpm.local",
    "commit",
    "--no-gpg-sign",
    "-m",
    "seed",
  );
  // Normalise the default branch name regardless of the host git's default.
  await git(dir, "branch", "-M", "main");
  return dir;
}

/** Best-effort recursive cleanup of every registered temp root. */
export async function cleanup(roots: readonly string[]): Promise<void> {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A well-formed measured/authoritative record, with per-test overrides. */
export function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const base: MemoryRecord = {
    schemaVersion: 1,
    id: "rec-1",
    scope: "epic",
    scopeRef: "issue-303",
    mode: "empirical",
    provenance: "measured",
    authority: "authoritative",
    statement: "the measured throughput was 42 rps",
    createdAt: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}
