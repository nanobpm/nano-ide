// Node/Deno filesystem implementation of the GenIO port. Uses node:fs/promises, which both
// Node and Deno provide, so a single implementation serves both runtimes.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GenIO } from "./gen.ts";

export function createNodeGenIO(): GenIO {
  return {
    async readText(path: string): Promise<string> {
      return readFile(path, "utf8");
    },
    async writeText(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async listDir(path: string): Promise<string[]> {
      try {
        // The GenIO contract is file names only — exclude subdirectories so
        // pattern expansion never hands a directory to readText()/JSON.parse.
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async listSubdirs(path: string): Promise<string[]> {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async remove(path: string): Promise<void> {
      await rm(path, { force: true });
    },
    // Import an app module for code-first model derivation. `import()` of a file URL loads TS on
    // Deno natively and on Node with type-stripping (≥22.18 default, or `--experimental-strip-types`).
    // The cache key is the file's mtime, not a monotonic clock: an unchanged workflow reuses the
    // cached module instance (bounding the ESM module map in long-lived processes like `urban dev`)
    // while an edited one still reloads.
    async importModule(path: string): Promise<Record<string, unknown>> {
      const abs = resolve(path);
      let version = "";
      try {
        version = `?v=${(await stat(abs)).mtimeMs}`;
      } catch {
        // stat failed (e.g. a virtual path); fall back to no cache key and let import() surface it.
      }
      const href = `${pathToFileURL(abs).href}${version}`;
      const mod: Promise<Record<string, unknown>> = import(href);
      return mod;
    },
  };
}
