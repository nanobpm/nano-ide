// Slice s6-pii-ci — tests for the build-time PII gate (`scripts/check-pii.ts`).
//
// These seed records into the SAME S3 path/namespace layout the writer uses
// (`recordRelativePath`), then run the real check-pii.ts script against a local
// temp substrate and assert its exit code: non-zero on a seeded PII violation,
// zero on clean content. Nothing touches the network.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordRelativePath } from "../git/index.ts";
import type { MemoryRecord } from "../schema/index.ts";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
// packages/urban/src/context/pii → packages/urban/scripts/check-pii.ts
const CHECK_PII = join(HERE, "..", "..", "..", "scripts", "check-pii.ts");
const TEMP_ROOTS: string[] = [];

after(async () => {
  await Promise.all(TEMP_ROOTS.map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
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

/** Write a record into a substrate root at its canonical S3 layout path. */
async function seed(root: string, rec: MemoryRecord): Promise<void> {
  const rel = recordRelativePath(rec);
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s6ci-substrate-"));
  TEMP_ROOTS.push(dir);
  return dir;
}

/** Run check-pii.ts against a root; resolve with its exit code + stderr. */
async function runCheck(root: string): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", CHECK_PII, root],
      { cwd: root },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: numberProp(error, "code") ?? 1,
      stdout: stringProp(error, "stdout"),
      stderr: stringProp(error, "stderr"),
    };
  }
}

function numberProp(error: unknown, key: string): number | undefined {
  const value =
    typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
  return typeof value === "number" ? value : undefined;
}

function stringProp(error: unknown, key: string): string {
  const value =
    typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
  return typeof value === "string" ? value : "";
}

test("check:pii passes (exit 0) on clean records in the S3 layout", async () => {
  const root = await makeRoot();
  await seed(root, record({ id: "clean-a" }));
  await seed(
    root,
    record({ id: "clean-b", scope: "repo", scopeRef: undefined, statement: "latency held at 42ms" }),
  );

  const { code, stdout } = await runCheck(root);
  assert.equal(code, 0, `expected clean content to pass; stdout=${stdout}`);
  assert.match(stdout, /no PII detected/);
});

test("check:pii fails (non-zero) on a seeded PII violation in the S3 layout", async () => {
  const root = await makeRoot();
  await seed(root, record({ id: "clean-a" }));
  // A record whose statement carries an email address — a PII violation.
  await seed(
    root,
    record({ id: "leaky", statement: "reported by alice.example@contoso.com during the run" }),
  );

  const { code, stderr } = await runCheck(root);
  assert.equal(code, 1, "expected a seeded PII violation to fail the build");
  assert.match(stderr, /PII detected/);
  assert.match(stderr, /email/);
  // The gate must NOT re-leak the raw PII it caught (length-only redaction).
  assert.doesNotMatch(stderr, /alice\.example@contoso\.com/);
});

test("check:pii is a no-op (exit 0) on a root with no records/ layout", async () => {
  const root = await makeRoot();
  const { code, stdout } = await runCheck(root);
  assert.equal(code, 0);
  assert.match(stdout, /0 record\(s\) scanned/);
});
