// Slice s6-pii-ci — the OUTER, build-time half of the no-PII guard.
//
// The inline, by-construction net already exists: S6-core ships the PII
// classifier + mandatory default-DENY pre-commit guard, and S3 wires that guard
// as the non-optional pre-commit step on every git write path, so PII can never
// be committed through the writer. This script is the SECOND line of defence —
// a build-time scan run in CI (`npm run check:pii --workspace @nanobpm/urban`)
// that walks content ALREADY targeted at a git-backed context (records laid out
// under the S3 path/namespace partitioning) and re-classifies it with the SAME
// S6-core classifier. It exits non-zero on any violation (failing the build) and
// zero on clean content. It never weakens or duplicates the core guard — it
// reuses `classifyPii` verbatim.
//
// Usage:
//   node --experimental-strip-types scripts/check-pii.ts [rootDir ...]
//
// Each `rootDir` (default: the current working directory) is treated as a
// substrate root; the script scans every record file beneath its `records/`
// layout (see @nanobpm/urban/context/git `isRecordPath`). Findings are reported
// with their kind + located field path and a length-only redacted excerpt, so a
// failing run never re-leaks the PII it caught.

import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { classifyPii, type PiiFinding } from "../src/context/pii/index.ts";
import { LAYOUT_ROOT, isRecordPath } from "../src/context/git/index.ts";

interface RecordViolation {
  readonly file: string;
  readonly findings: readonly PiiFinding[];
}

/** `true` when a thrown error is a Node "no such file or directory" error. */
function isMissingPath(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "ENOENT";
}

/** Narrow an unknown JSON value to a scannable plain object (arrays excluded). */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walk a substrate root and return every layout record file (absolute paths). */
async function collectRecordFiles(root: string): Promise<string[]> {
  const layoutRoot = join(root, LAYOUT_ROOT);
  let entries: string[];
  try {
    entries = await readdir(layoutRoot, { recursive: true });
  } catch (error) {
    // A root with no `records/` directory simply has nothing to scan.
    if (isMissingPath(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(layoutRoot, entry);
    const relFromRoot = relative(root, absolute).split(sep).join("/");
    if (!isRecordPath(relFromRoot)) continue;
    // Only scan real, regular files. `lstat` (not `stat`) does not follow the
    // final component, so a symlink — even one matching `records/**.json` — is
    // rejected here and can never make the scanner `readFile` a target outside
    // the substrate root (e.g. a CI secret), which would otherwise be read and
    // classified. Non-regular entries (fifos, devices, sockets) are skipped too.
    const stats = await lstat(absolute);
    if (stats.isFile()) files.push(absolute);
  }
  return files;
}

/** Classify one record file, preferring its parsed JSON shape over raw text. */
async function classifyFile(file: string): Promise<readonly PiiFinding[]> {
  const text = await readFile(file, "utf8");
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    // A record that is not valid JSON still gets scanned as raw text so PII can
    // never slip through on a malformed file.
    return classifyPii(text).findings;
  }
  if (isPlainObject(candidate)) {
    return classifyPii(candidate).findings;
  }
  return classifyPii(text).findings;
}

async function main(): Promise<number> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push(process.cwd());

  const violations: RecordViolation[] = [];
  let scanned = 0;
  for (const root of roots) {
    const files = await collectRecordFiles(root);
    for (const file of files) {
      scanned += 1;
      const findings = await classifyFile(file);
      if (findings.length > 0) violations.push({ file, findings });
    }
  }

  if (violations.length > 0) {
    console.error(
      `check:pii — FAILED: PII detected in ${violations.length} of ${scanned} scanned record(s).`,
    );
    for (const { file, findings } of violations) {
      for (const f of findings) {
        const where = f.path ? ` @ ${f.path}` : "";
        console.error(`  ${file}: ${f.kind}${where} (${f.excerpt}) — ${f.reason}`);
      }
    }
    return 1;
  }

  console.log(`check:pii — OK: ${scanned} record(s) scanned, no PII detected.`);
  return 0;
}

const code = await main();
process.exit(code);
