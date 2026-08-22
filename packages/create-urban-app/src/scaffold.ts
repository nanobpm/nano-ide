// The scaffolder core: materialize a runnable Urban app repo from the bundled template,
// substituting the app id/name. Pure codegen — no runtime logic. Uses node:fs/node:path,
// which both Node and Deno provide, so `npm create urban-app` and
// `deno run -A npm:create-urban-app` both work.

import { cp, mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScaffoldOptions {
  /** App name (human-readable). */
  name: string;
  /** Target directory (created if missing). */
  dir: string;
  /** App id slug. Default: derived from name. */
  id?: string;
  /** Preset: "full" (workers + surfaces + triggers) or "headless" (workers only). */
  preset?: "full" | "headless";
  /**
   * Authoring style: "model" (default) scaffolds a model-first app whose process
   * is an authored `processes/*.bpmn`, run by `urban run`. "code" scaffolds a
   * code-first app whose process is authored in TypeScript with `defineFlow`
   * (`workflows/*.ts`); `@nanobpm/urban` derives the executable model, and a
   * custom `main.ts` deploys it and hosts the in-process worker.
   */
  style?: "model" | "code";
  /**
   * Also emit Deno host files (`deno.json`) and keep the Deno usage docs. Default false:
   * the scaffold normalizes on Node to keep the authoring experience simple. The runtime
   * stays host-agnostic, so `--deno` is purely additive.
   */
  deno?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  id: string;
  files: string[];
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "urban-app";
}

function templateRoot(style: "model" | "code"): string {
  const dir = style === "code" ? "template-code-first" : "template";
  return join(dirname(fileURLToPath(import.meta.url)), "..", dir);
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(root);
  return out;
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/__([A-Z_]+)__/g, (m, key) => vars[key] ?? m);
}

/**
 * Resolve `<!-- if:deno -->…<!-- /if:deno -->` blocks in template text. When `deno` is on,
 * only the marker lines are stripped (the body stays); when off, the whole block goes. Lets
 * one README serve both the Node-default and `--deno` scaffolds without a second template.
 */
function applyConditionals(content: string, on: { deno: boolean }): string {
  const block = /^[ \t]*<!-- if:deno -->[ \t]*\r?\n([\s\S]*?)^[ \t]*<!-- \/if:deno -->[ \t]*\r?\n?/gm;
  return content.replace(block, (_m, body: string) => (on.deno ? body : ""));
}

/**
 * Rename template entries that can't live under their real name inside this repo:
 * dotfiles npm strips from packs (`_gitignore`, `_github`), and `_biome.json` — a
 * `root: true` config that would otherwise be discovered as a conflicting nested
 * root by the monorepo's own Biome scan. The scaffolded app gets the real names.
 */
function finalName(name: string): string {
  if (name === "_gitignore") return ".gitignore";
  if (name === "_github") return ".github";
  if (name === "_biome.json") return "biome.json";
  return name;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const id = opts.id ?? slugify(opts.name);
  const preset = opts.preset ?? "full";
  const headless = preset === "headless";
  const deno = opts.deno ?? false;
  const style = opts.style ?? "model";
  // JSON-escape the name so it stays valid inside the quoted JSON placeholders
  // (e.g. nano.app.json "name") for arbitrary input (quotes, backslashes, control chars).
  const vars = { APP_ID: id, APP_NAME: JSON.stringify(opts.name).slice(1, -1) };
  const root = templateRoot(style);
  const files = await listFiles(root);
  const written: string[] = [];

  await mkdir(opts.dir, { recursive: true });
  for (const src of files) {
    const rel = relative(root, src);
    const parts = rel.split(/[/\\]/).map(finalName);
    const destRel = parts.join("/");
    // headless = workers only: no human surfaces, so skip the form + page assets. Forms deploy by
    // convention from `resources/forms/`; skipping those files keeps them out of the deployment.
    // The `api` binding, its `operations/`, and `openapi.yaml` are a machine surface and stay.
    if (headless && (destRel.startsWith("resources/forms/") || destRel.startsWith("pages/"))) continue;
    // Node is the default host; Deno host files are opt-in via `--deno`.
    if (!deno && destRel === "deno.json") continue;
    // tsconfig.json backs the default Node `tsc --noEmit` typecheck; under `--deno` the
    // typecheck runs `deno check` instead, so the Node tsconfig is unneeded.
    if (deno && destRel === "tsconfig.json") continue;
    const dest = join(opts.dir, destRel);
    await mkdir(dirname(dest), { recursive: true });
    const raw = await readFile(src, "utf8");
    let content = applyConditionals(substitute(raw, vars), { deno });
    if (deno && destRel === "package.json") content = toDenoPackageJson(content, style);
    if (headless && destRel === "nano.app.json") content = toHeadlessManifest(content);
    await writeFile(dest, content);
    written.push(destRel);
  }
  return { dir: opts.dir, id, files: written.sort() };
}

/**
 * `--deno`: point the Node `package.json` typecheck back at `deno check` and drop the
 * Node-only TypeScript toolchain devDeps (the Deno host typechecks via `deno check`, and
 * `deno.json` carries the parallel task). Everything else stays so the app still runs on Node.
 */
function toDenoPackageJson(json: string, style: "model" | "code"): string {
  const pkg: {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(json);
  const denoCheck =
    style === "code"
      ? 'deno check main.ts "workflows/**/*.ts" "scripts/**/*.ts"'
      : 'deno check main.ts "nano-generated/controller.ts" "workers/**/*.ts" "operations/**/*.ts"';
  if (pkg.scripts) pkg.scripts.typecheck = denoCheck;
  if (pkg.devDependencies) {
    delete pkg.devDependencies["@types/node"];
    delete pkg.devDependencies.typescript;
  }
  return JSON.stringify(pkg, null, "\t") + "\n";
}

/** headless preset: drop the human-facing surfaces and triggers. Forms are dropped by skipping
 *  their `resources/forms/` files at copy time (deploy-by-convention then sees none). */
function toHeadlessManifest(json: string): string {
  const m: {
    surfaces?: unknown;
    triggers?: unknown;
  } = JSON.parse(json);
  delete m.surfaces;
  delete m.triggers;
  return JSON.stringify(m, null, "\t") + "\n";
}

// Re-export for callers that want the template path (e.g. tests).
export { cp, stat };
