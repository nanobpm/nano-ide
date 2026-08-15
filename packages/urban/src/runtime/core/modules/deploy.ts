// deploy — resolve the app's deployable resources and send them to the engine.
//
// Resources are found by ONE of two paths:
//   1. Convention (the default, ADR 0062): when the manifest declares no `models`, deployables are
//      discovered by walking `resources/` — shallow, one level deep. `resources/` is deploy-only:
//      everything under it (and nothing outside it) is deployed. Docs (`docs/`, `AGENTS.md`,
//      top-level `*.md`) live outside `resources/` and are never swept in.
//   2. Explicit override: when the manifest declares `models` globs, those are used exactly (the
//      convention walk is skipped) — the escape hatch for a non-convention layout.
//
// Either way the deploy dedupe key is the resource's basename (filename only), so a basename
// collision — two files with the same name in different directories — would silently clobber one
// resource with another at the engine. We detect that up front and fail loudly instead.

import type { RuntimeContext } from "../context.ts";
import { discoverResources, expandPatterns } from "../glob.ts";

/** The convention directory: deploy-only, walked one level deep when no `models` are declared. */
export const RESOURCES_DIR = "resources";

function contentTypeFor(path: string): string {
  if (path.endsWith(".bpmn")) return "text/xml";
  if (path.endsWith(".dmn")) return "text/xml";
  if (path.endsWith(".form")) return "application/json";
  return "application/octet-stream";
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Fail loudly when two resolved files share a basename (the deploy dedupe key), naming the
 *  colliding paths so the author can rename or relocate one. */
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
 * Deploy the app's processes, decisions and forms.
 *
 * With no manifest `models`, deployables are discovered by convention under `resources/` (shallow,
 * one level deep). With `models` globs declared, those are used verbatim. Basename collisions are a
 * hard error in either mode.
 */
export async function deployModels(ctx: RuntimeContext): Promise<{ deployed: number; files: string[] }> {
  const models = ctx.manifest.models ?? {};
  const patterns = [
    ...(models.processes ?? []),
    ...(models.decisions ?? []),
    ...(models.forms ?? []),
  ];
  const byConvention = patterns.length === 0;
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
  assertNoBasenameCollisions(files);
  const resources = await Promise.all(
    files.map(async (path) => ({
      name: baseName(path),
      content: await ctx.host.readTextFile(path),
      contentType: contentTypeFor(path),
    })),
  );
  const { deployed } = await ctx.engine.deployResources(resources);
  ctx.host.log("info", "deploy: models deployed", { deployed, files, byConvention });
  return { deployed, files };
}
