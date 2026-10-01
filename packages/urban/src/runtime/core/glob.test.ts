import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPattern, expandPatterns } from "./glob.ts";
import type { HostContext } from "./host.ts";

function fakeHost(files: Record<string, string[]>): HostContext {
  // files: dir -> file names
  return {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async (dir) => files[dir.replace(/\/+$/, "")] ?? [],
    exists: async (p) => {
      const slash = p.lastIndexOf("/");
      const dir = slash >= 0 ? p.slice(0, slash) : "";
      const name = slash >= 0 ? p.slice(slash + 1) : p;
      return (files[dir] ?? []).includes(name);
    },
    statFile: async (p) => {
      const slash = p.lastIndexOf("/");
      const dir = slash >= 0 ? p.slice(0, slash) : "";
      const name = slash >= 0 ? p.slice(slash + 1) : p;
      return (files[dir] ?? []).includes(name) ? { isFile: true } : null;
    },
    openSqlite: () => {
      throw new Error("n/a");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
}

test("expandPattern: *.ext filters by extension and sorts", async () => {
  const host = fakeHost({ "root/processes": ["b.bpmn", "a.bpmn", "note.md"] });
  const out = await expandPattern(host, "root", "processes/*.bpmn");
  assert.deepEqual(out, ["root/processes/a.bpmn", "root/processes/b.bpmn"]);
});

test("expandPattern: literal path resolves only if it exists", async () => {
  const host = fakeHost({ "root/dir": ["x.dmn"] });
  assert.deepEqual(await expandPattern(host, "root", "dir/x.dmn"), ["root/dir/x.dmn"]);
  assert.deepEqual(await expandPattern(host, "root", "dir/missing.dmn"), []);
});

test("expandPatterns de-duplicates preserving order", async () => {
  const host = fakeHost({ "root/d": ["a.form", "b.form"] });
  const out = await expandPatterns(host, "root", ["d/*.form", "d/a.form"]);
  assert.deepEqual(out, ["root/d/a.form", "root/d/b.form"]);
});
