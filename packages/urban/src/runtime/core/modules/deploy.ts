// deploy — resolve the app's deployable resources and send them to the engine.
//
// Resources are found by ONE of two paths:
//   1. Convention (the default, ADR 0062): when the manifest declares no `models`, deployables are
//      discovered by walking `resources/` **recursively** — every file under it, at any depth
//      (issue #231). `resources/` is deploy-only: everything under it (and nothing outside it) is
//      deployed. Docs (`docs/`, `AGENTS.md`, top-level `*.md`) live outside `resources/` and are
//      never swept in. A convention resource's deploy key (`resourceId`) is its path **relative to
//      `resources/`** (POSIX-normalised), e.g. `resources/prompts/plan.md` → `prompts/plan.md`, so
//      a linked service task references it with `zeebe:linkedResource resourceId="prompts/plan.md"`.
//      The relative path (not the bare basename) preserves sub-directory structure and lets two
//      files sharing a filename in different sub-dirs (`a/x.md`, `b/x.md`) deploy as distinct
//      resources — there is no basename-collision hazard.
//   2. Explicit override: when the manifest declares `models` globs, those are used exactly (the
//      convention walk is skipped) — the escape hatch for a non-convention layout. Override
//      resources are keyed by basename (filename only), so a basename collision across the declared
//      globs is a hard error, detected up front.
//
// Content is deployed **verbatim** — there is no deploy-time `{{token}}` substitution (removed in
// ADR 0062) — so a generic resource (a prompt `.md`, an RPA/script file) is deployed byte-for-byte.

import type { RuntimeContext } from "../context.ts";
import { discoverResources, expandPatterns } from "../glob.ts";

/** The convention directory: deploy-only, walked recursively when no `models` are declared. */
export const RESOURCES_DIR = "resources";

/**
 * Classify a file into an engine content type by extension. Models get their real XML/JSON types;
 * generic resources get a real text content type where the extension is known (`.md`, `.json`,
 * `.txt`), falling back to `application/octet-stream` for anything unrecognised (so an unknown
 * binary is never mislabelled). The engine deploys a non-model content type as a generic resource
 * (versioned per `resourceId`); a service task resolves it via
 * `zeebe:linkedResource resourceId="<id>" bindingType:latest`.
 */
function contentTypeFor(path: string): string {
  if (path.endsWith(".bpmn")) return "text/xml";
  if (path.endsWith(".dmn")) return "text/xml";
  if (path.endsWith(".form")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * A convention resource's `resourceId`: its path relative to `<root>/resources/` (POSIX). Given a
 * root-prefixed discovered path (`/app/resources/prompts/plan.md`) it returns `prompts/plan.md`.
 * Falls back to the basename if — defensively — the path is not under the resources prefix.
 */
function relativeResourceId(path: string, root: string): string {
  const prefix = `${root.replace(/\/+$/, "")}/${RESOURCES_DIR}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : baseName(path);
}

/** Fail loudly when two resolved files share a basename (the override dedupe key), naming the
 *  colliding paths so the author can rename or relocate one. Only relevant for the `models`
 *  override path; convention resources are keyed by relative path and cannot collide. */
function assertNoBasenameCollisions(files: string[]): void {
  const byName = new Map<string, string[]>();
  for (const path of files) {
    const name = baseName(path);
    const list = byName.get(name);
    if (list) list.push(path);
    else byName.set(name, [path]);
  }
  const collisions = [...byName.entries()].filter(([, paths]) => paths.length > 1);
  if (collisions.length === 0) return;
  const detail = collisions
    .map(([name, paths]) => `  ${name}: ${paths.slice().sort().join(", ")}`)
    .join("\n");
  throw new Error(
    "deploy: basename collision — resources are deployed keyed by filename, so two files with " +
      `the same name would clobber each other. Rename or relocate one of:\n${detail}`,
  );
}

/**
 * Deploy the app's resources.
 *
 * With no manifest `models`, deployables are discovered by convention under `resources/`
 * (recursively — every file at any depth) and each is keyed by its path relative to `resources/`
 * (POSIX). With `models` globs declared, those are used verbatim and keyed by basename (a basename
 * collision is a hard error). Content is deployed verbatim (no template substitution); each file is
 * content-typed by extension so a generic resource (e.g. a prompt `.md`) deploys as a versioned
 * generic resource the engine resolves via `zeebe:linkedResource bindingType:latest`.
 */
export async function deployModels(ctx: RuntimeContext): Promise<{ deployed: number; files: string[] }> {
  const models = ctx.manifest.models;
  const patterns = [
    ...(models?.processes ?? []),
    ...(models?.decisions ?? []),
    ...(models?.forms ?? []),
  ];
  // Convention is keyed off the *absence* of the `models` block, not an empty pattern set: a
  // declared `models` (even one resolving to zero files) is an explicit override that must NOT
  // silently fall back to the `resources/` walk (ADR 0062: "no `models` block → convention;
  // `models` present → exact override").
  const byConvention = models === undefined;
  const files = byConvention
    ? await discoverResources(ctx.host, ctx.root, RESOURCES_DIR)
    : await expandPatterns(ctx.host, ctx.root, patterns);
  if (files.length === 0) {
    if (byConvention) {
      ctx.host.log("info", "deploy: no resources found by convention", { dir: RESOURCES_DIR });
    } else {
      ctx.host.log("info", "deploy: no model files matched", { patterns });
    }
    return { deployed: 0, files: [] };
  }
  // Convention resources are keyed by their (unique) relative path; only the override path, whose
  // basename key can collide across globs, needs the collision guard.
  if (!byConvention) assertNoBasenameCollisions(files);
  const resources = await Promise.all(
    files.map(async (path) => ({
      name: byConvention ? relativeResourceId(path, ctx.root) : baseName(path),
      content: await ctx.host.readTextFile(path),
      contentType: contentTypeFor(path),
    })),
  );
  const { deployed } = await ctx.engine.deployResources(resources);
  ctx.host.log("info", "deploy: resources deployed", { deployed, files, byConvention });
  return { deployed, files };
}
