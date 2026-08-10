import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODULE_EXTENSION_CANDIDATES, resolveModulePath } from "./module-path.ts";
import { createNodeHost } from "../adapters/node.ts";

test("resolveModulePath leaves an already-extensioned path untouched", () => {
  const never = () => {
    throw new Error("exists() must not be consulted for an extensioned path");
  };
  assert.equal(resolveModulePath("/a/b/x.ts", never), "/a/b/x.ts");
  assert.equal(resolveModulePath("/a/b/x.js", never), "/a/b/x.js");
  assert.equal(resolveModulePath("/a/b/x.mjs", never), "/a/b/x.mjs");
  assert.equal(resolveModulePath("/a/b/x.cjs", never), "/a/b/x.cjs");
});

test("resolveModulePath appends the first candidate extension that exists", () => {
  const present = new Set(["/ops/getX.js"]);
  const resolved = resolveModulePath("/ops/getX", (c) => present.has(c));
  assert.equal(resolved, "/ops/getX.js");
});

test("resolveModulePath prefers .ts over .js when both exist", () => {
  const present = new Set(["/ops/getX.ts", "/ops/getX.js"]);
  const resolved = resolveModulePath("/ops/getX", (c) => present.has(c));
  assert.equal(resolved, "/ops/getX.ts");
  assert.equal(MODULE_EXTENSION_CANDIDATES[0], ".ts");
});

test("resolveModulePath returns the path unchanged when nothing exists", () => {
  const resolved = resolveModulePath("/ops/missing", () => false);
  assert.equal(resolved, "/ops/missing");
});

test("createNodeHost.importModule loads an extensionless .ts delegate from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "urban-import-"));
  try {
    writeFileSync(
      join(dir, "getVersion.ts"),
      "export const marker = 'from-ts';\nexport default { marker };\n",
    );
    const host = createNodeHost({ cwd: dir });
    // Path carries NO extension — mirrors how the OpenAPI delegate surface builds
    // `<dir>/<operationId>`. Without extension probing this throws ERR_MODULE_NOT_FOUND.
    const mod = await host.importModule(join(dir, "getVersion"));
    assert.equal(mod.marker, "from-ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
