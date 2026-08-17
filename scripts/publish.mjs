// Publish each public workspace whose version isn't yet on npm, then ensure a
// GitHub Release exists for that published version. Idempotent (skips
// already-published versions and already-created releases) and tolerant of
// transient sigstore/rekor hiccups (one retry). Run by the release workflow.
// Needs NODE_AUTH_TOKEN (npm, via OIDC Trusted Publisher) and GH_TOKEN (gh).
//
// The GitHub Release is the queryable `capability -> firstVersion` PROVENANCE
// index the cross-repo release-DAG (nano-workforce#263) consumes: a downstream
// consumer that depends on an upstream CAPABILITY (an issue/PR, not a version)
// polls for new published versions and matches the capability ref against a
// release's provenance body, then late-binds the concrete version. Publishing
// records which issues/PRs a version first shipped so that match is a
// deterministic lookup rather than an agent judgement. Each release is:
//   - tagged `<name>@<version>` (per-package, monorepo-safe), and
//   - bodied with the distinct `#NNN` issue/PR refs from commits touching the
//     package's own directory since its previous `<name>@*` tag (dir-scoped so
//     an unrelated package's PRs never leak into this package's provenance).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";

const dirs = JSON.parse(execFileSync("npm", ["query", ".workspace"], { encoding: "utf8" }))
  .map((w) => w.path)
  .filter(Boolean);

/** Run a command, returning trimmed stdout or "" on failure (never throws). */
function tryOut(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Compare two dotted version strings numerically (major.minor.patch). */
function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The highest existing `<name>@<version>` tag strictly below `version`, or null
 *  (the package's previous release — the lower bound of this release's provenance
 *  range). Requires tags to be fetched (release.yml checks out with fetch-depth 0). */
function prevTagFor(name, version) {
  const prefix = `${name}@`;
  const lower = tryOut("git", ["tag", "--list", `${prefix}*`])
    .split("\n")
    .filter(Boolean)
    .map((t) => t.slice(prefix.length))
    .filter((v) => /^\d+(\.\d+)*$/.test(v) && cmpVersion(v, version) < 0)
    .sort(cmpVersion);
  return lower.length ? `${prefix}${lower[lower.length - 1]}` : null;
}

/** Distinct `#NNN` issue/PR refs from commit subjects+bodies that touched `dir`
 *  since `prevTag` (or all of `dir`'s history for the bootstrap release with no
 *  prior tag). Dir-scoped so a monorepo sibling's PRs never leak in. */
function refsFor(dir, prevTag) {
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const log = tryOut("git", ["log", range, "--format=%s%n%b", "--", dir]);
  const refs = new Set();
  for (const m of log.matchAll(/#(\d+)/g)) refs.add(Number(m[1]));
  return [...refs].sort((a, b) => a - b);
}

/** Ensure a GitHub Release exists for `<name>@<version>`, creating it (tag +
 *  provenance body) if missing. Best-effort: a failure here never fails the job
 *  (the npm publish already happened and cannot be undone) — a later run
 *  backfills the release idempotently. */
function ensureRelease(dir, name, version, targetSha) {
  const tag = `${name}@${version}`;
  if (tryOut("gh", ["release", "view", tag, "--json", "tagName"])) {
    console.log(`= release ${tag} exists`);
    return true;
  }
  const prev = prevTagFor(name, version);
  const refs = refsFor(dir, prev);
  const list = refs.length ? refs.map((n) => `- #${n}`).join("\n") : "- _(none)_";
  const since = prev ? ` since \`${prev}\`` : " (initial tagged release)";
  const body =
    `Automated release of \`${name}@${version}\`.\n\n` +
    `## Provenance\n` +
    `Issues/PRs shipped in this version${since}, from commits touching \`${dir}\`:\n\n` +
    `${list}\n`;
  const args = ["release", "create", tag, "--title", tag, "--notes", body];
  if (targetSha) args.push("--target", targetSha);
  try {
    execFileSync("gh", args, { stdio: "inherit" });
    console.log(`+ release ${tag} (${refs.length} refs)`);
    return true;
  } catch {
    console.error(`✗ release ${tag} (publish succeeded; a later run will backfill)`);
    return false;
  }
}

const targetSha = tryOut("git", ["rev-parse", "HEAD"]) || undefined;

let published = 0, failed = 0, releaseFailed = 0;
for (const dir of dirs) {
  const p = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  if (p.private) continue;
  let live = "";
  try { live = execFileSync("npm", ["view", `${p.name}@${p.version}`, "version"], { encoding: "utf8" }).trim(); }
  catch { /* not published yet */ }
  if (live === p.version) {
    console.log(`= ${p.name}@${p.version} already on npm`);
    // Backfill provenance for an already-published version whose release is missing.
    if (!ensureRelease(relative(process.cwd(), dir) || ".", p.name, p.version, targetSha)) releaseFailed++;
    continue;
  }
  let didPublish = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync("npm", ["publish", "--access", "public", "--provenance"], { cwd: dir, stdio: "inherit" });
      console.log(`+ ${p.name}@${p.version}`); published++; didPublish = true; break;
    } catch {
      if (attempt === 2) { console.error(`✗ ${p.name}@${p.version}`); failed++; }
    }
  }
  if (didPublish && !ensureRelease(relative(process.cwd(), dir) || ".", p.name, p.version, targetSha)) releaseFailed++;
}
console.log(`\npublished ${published}, failed ${failed}, release-provenance failures ${releaseFailed}`);
// Release-provenance is best-effort (backfilled on a later run); only a failed
// npm publish fails the job.
if (failed) process.exit(1);
