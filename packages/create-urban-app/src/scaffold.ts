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

/** Rename template entries that stand in for dotfiles npm strips from packs. */
function finalName(name: string): string {
  if (name === "_gitignore") return ".gitignore";
  if (name === "_github") return ".github";
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
    // headless = workers only: no human surfaces, so skip the form + page assets. The
    // `api` binding, its `operations/`, and `openapi.json` are a machine surface and stay.
    if (headless && (destRel.startsWith("forms/") || destRel.startsWith("pages/"))) continue;
    // Node is the default host; Deno host files are opt-in via `--deno`.
    if (!deno && destRel === "deno.json") continue;
    const dest = join(opts.dir, destRel);
    await mkdir(dirname(dest), { recursive: true });
    const raw = await readFile(src, "utf8");
    let content = applyConditionals(substitute(raw, vars), { deno });
    if (headless && destRel === "nano.app.json") content = toHeadlessManifest(content);
    await writeFile(dest, content);
    written.push(destRel);
  }
  return { dir: opts.dir, id, files: written.sort() };
}

/** headless preset: drop the human-facing surfaces, triggers and form models. */
function toHeadlessManifest(json: string): string {
  const m: {
    surfaces?: unknown;
    triggers?: unknown;
    models?: { forms?: unknown };
  } = JSON.parse(json);
  delete m.surfaces;
  delete m.triggers;
  if (m.models) delete m.models.forms;
  return JSON.stringify(m, null, 2) + "\n";
}

// Re-export for callers that want the template path (e.g. tests).
export { cp, stat };
