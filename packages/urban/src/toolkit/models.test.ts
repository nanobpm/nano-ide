import { test } from "node:test";
import assert from "node:assert/strict";
import { defineFlow, envelope } from "@nanobpm/workflow";
import { deriveModels, isWorkflow, bpmnFilename, processesOutDir, MODEL_PROVENANCE } from "./models.ts";
import type { GenIO } from "./gen.ts";

/** In-memory GenIO whose `importModule` returns pre-registered module exports by path. */
function memIO(
  files: Record<string, string>,
  modules: Record<string, Record<string, unknown>> = {},
): GenIO {
  return {
    async readText(p) {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    async writeText(p, c) {
      files[p] = c;
    },
    async listDir(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes("/")) names.add(rest);
        }
      }
      return [...names];
    },
    async exists(p) {
      return p in files || p in modules;
    },
    importModule(p) {
      const key = Object.keys(modules).find((k) => p.endsWith(k));
      if (!key) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(modules[key]);
    },
  };
}

const GreetIn = envelope("GreetIn", { who: "string" });
const GreetOut = envelope("GreetOut", { message: "string" });

/** A real one-step declarative flow (exercises the actual toBpmn + layout pipeline). */
const greet = defineFlow("greet", { hello: { in: GreetIn, out: GreetOut } }, (w) => {
  w.run("hello", async () => ({ message: "hi" }));
});

const CODE_FIRST_MANIFEST = { models: { workflows: ["workflows/*.ts"] } };

test("isWorkflow recognizes defineFlow exports, rejects everything else", () => {
  assert.equal(isWorkflow(greet), true);
  assert.equal(isWorkflow({ id: "x", kind: "imperative" }), true);
  assert.equal(isWorkflow({ id: "x", kind: "nope" }), false);
  assert.equal(isWorkflow({ kind: "declarative" }), false);
  assert.equal(isWorkflow(null), false);
  assert.equal(isWorkflow("greet"), false);
});

test("bpmnFilename sanitizes ids into safe .bpmn filenames", () => {
  assert.equal(bpmnFilename("greet"), "greet.bpmn");
  assert.equal(bpmnFilename("orders/place"), "orders-place.bpmn");
  assert.equal(bpmnFilename("a b:c"), "a-b-c.bpmn");
});

test("processesOutDir defaults to resources/processes/, or the dir of a models.processes glob", () => {
  assert.equal(processesOutDir({}), "resources/processes");
  assert.equal(processesOutDir({ models: { processes: ["resources/processes/*.bpmn"] } }), "resources/processes");
  assert.equal(processesOutDir({ models: { processes: ["src/models/*.bpmn"] } }), "src/models");
});

test("deriveModels turns workflows/*.ts into a provenance-stamped resources/processes/<id>.bpmn", async () => {
  const io = memIO(
    { "/app/workflows/greet.ts": "// source" },
    { "workflows/greet.ts": { greet } },
  );
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);

  assert.equal(d.attempted, true);
  assert.equal(d.incomplete, false);
  assert.deepEqual(d.ids, ["greet"]);
  assert.equal(d.artifacts.length, 1);
  assert.equal(d.artifacts[0].path, "resources/processes/greet.bpmn");
  assert.match(d.artifacts[0].content, /<!--.*@nanobpm\/urban/);
  assert.ok(d.artifacts[0].content.includes(MODEL_PROVENANCE));
  assert.match(d.artifacts[0].content, /greet/);
  // the in-memory ModelSource is fed to the type-contract derivers
  assert.deepEqual(d.models.map((m) => m.path), ["resources/processes/greet.bpmn"]);
  assert.equal(d.list[0].id, "greet");
  assert.equal(d.list[0].kind, "declarative");
});

test("deriveModels is a no-op without a module loader (pure/IDE callers)", async () => {
  const io = memIO({ "/app/workflows/greet.ts": "// source" });
  delete io.importModule;
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);
  assert.equal(d.attempted, false);
  assert.equal(d.artifacts.length, 0);
});

test("deriveModels writes into the manifest's models.processes dir when declared", async () => {
  const io = memIO(
    { "/app/workflows/greet.ts": "// source" },
    { "workflows/greet.ts": { greet } },
  );
  const d = await deriveModels("/app", io, {
    models: { workflows: ["workflows/*.ts"], processes: ["resources/processes/*.bpmn"] },
  });
  assert.equal(d.outDir, "resources/processes");
  assert.equal(d.artifacts[0].path, "resources/processes/greet.bpmn");
});

test("deriveModels records a failing workflow as incomplete without throwing", async () => {
  const io = memIO(
    { "/app/workflows/bad.ts": "// source" },
    {}, // no module registered → importModule rejects
  );
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);
  assert.equal(d.attempted, true);
  assert.equal(d.incomplete, true);
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].path, "workflows/bad.ts");
});

test("deriveModels flags a duplicate flow id across two files", async () => {
  const io = memIO(
    { "/app/workflows/a.ts": "// a", "/app/workflows/b.ts": "// b" },
    { "workflows/a.ts": { greet }, "workflows/b.ts": { greet } },
  );
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);
  assert.equal(d.incomplete, true);
  assert.ok(d.errors.some((e) => /duplicate flow id "greet"/.test(e.message)));
  assert.equal(d.ids.length, 1); // first wins
});

test("deriveModels flags two distinct flows sharing an id in the same module", async () => {
  // two SEPARATE defineFlow objects, same id, same file — a real collision, not a re-export.
  const greetA = defineFlow("greet", { hello: { in: GreetIn, out: GreetOut } }, (w) => {
    w.run("hello", async () => ({ message: "a" }));
  });
  const greetB = defineFlow("greet", { hello: { in: GreetIn, out: GreetOut } }, (w) => {
    w.run("hello", async () => ({ message: "b" }));
  });
  const io = memIO({ "/app/workflows/dup.ts": "// dup" }, { "workflows/dup.ts": { greetA, greetB } });
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);
  assert.equal(d.incomplete, true);
  assert.ok(d.errors.some((e) => /duplicate flow id "greet" \(also defined in the same module\)/.test(e.message)));
  assert.equal(d.ids.length, 1); // only the first is derived
});

test("deriveModels treats a genuine same-module re-export as one model, no error", async () => {
  // the SAME flow object exported under two names in one file — harmless.
  const io = memIO({ "/app/workflows/re.ts": "// re" }, { "workflows/re.ts": { greet, alsoGreet: greet } });
  const d = await deriveModels("/app", io, CODE_FIRST_MANIFEST);
  assert.equal(d.incomplete, false);
  assert.deepEqual(d.errors, []);
  assert.equal(d.ids.length, 1);
});
