// Slice s6-pii-ci — tests for the build-time PII gate (`scripts/check-pii.ts`).
//
// These seed records into the SAME S3 path/namespace layout the writer uses
// (`recordRelativePath`), then run the real check-pii.ts script against a local
// temp substrate and assert its exit code: non-zero on a seeded PII violation,
// zero on clean content. Nothing touches the network.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

/** Write raw file content into a substrate root at a record's canonical path. */
async function seedRaw(root: string, rec: MemoryRecord, content: string): Promise<void> {
  const rel = recordRelativePath(rec);
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
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

test("check:pii catches PII in a JSON array record (arrays are not plain objects)", async () => {
  const root = await makeRoot();
  // A record file whose top-level JSON value is an array carrying an email
  // address. Arrays must NOT be narrowed as plain objects — they fall through
  // to the raw-text scan, so the leak is still caught.
  await seedRaw(
    root,
    record({ id: "arr-leak" }),
    `${JSON.stringify(["contact alice.example@contoso.com for details"], null, 2)}\n`,
  );

  const { code, stderr } = await runCheck(root);
  assert.equal(code, 1, "expected a PII violation inside a JSON array record to fail the build");
  assert.match(stderr, /PII detected/);
  assert.match(stderr, /email/);
  assert.doesNotMatch(stderr, /alice\.example@contoso\.com/);
});

test("check:pii is a no-op (exit 0) on a root with no records/ layout", async () => {
  const root = await makeRoot();
  const { code, stdout } = await runCheck(root);
  assert.equal(code, 0);
  assert.match(stdout, /0 record\(s\) scanned/);
});

test("check:pii does not follow a symlink record into a target outside the root", async () => {
  const root = await makeRoot();
  // A secret file OUTSIDE the substrate root (e.g. a CI secret the scanner
  // should never touch), carrying an email address.
  const secret = join(await makeRoot(), "ci-secret.txt");
  await writeFile(secret, "token owner: alice.example@contoso.com\n", "utf8");
  // A symlink placed at a canonical record path that points at that secret. The
  // scanner must reject non-regular files (symlinks) up front — otherwise a
  // crafted `records/**.json` symlink would make it read and classify content
  // outside the intended substrate root.
  const rel = recordRelativePath(record({ id: "evil-link" }));
  const linkPath = join(root, rel);
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(secret, linkPath);

  const { code, stdout } = await runCheck(root);
  assert.equal(code, 0, `symlinked record must be skipped, not scanned; stdout=${stdout}`);
  assert.match(stdout, /0 record\(s\) scanned/);
});
