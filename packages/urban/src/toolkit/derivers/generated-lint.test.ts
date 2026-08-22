import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGen, type GenIO } from "../gen.ts";

// Defect-class guard (AGENTS.md "write a test guard for the defect class"): the emitters must
// produce `nano-generated/` code that passes the `create-urban-app` scaffold's own Biome lint
// ruleset — the exact standard a scaffolded app enforces via `npm run lint`. This locks the whole
// generator surface (types, meta accessor, domain/message/worker bindings, and the API controller's
// import order) to lint-clean output, so a future emitter change that reintroduces a banned type,
// an `as` cast, or a mis-sorted import fails here instead of only surfacing in a user's project.
//
// The generated code is deliberately console/deno-styled (2-space, quoted keys) for byte-parity
// with the console emitters (ADR 0053), so — mirroring the scaffold's `biome.json` — the formatter
// is scoped away from `nano-generated/` while the linter (and import-organizing assist) still apply.

/** In-memory filesystem so gen runs without touching disk. */
function memIO(files: Record<string, string>): GenIO & { files: Record<string, string> } {
  return {
    files,
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
    async listSubdirs(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash > 0) names.add(rest.slice(0, slash));
        }
      }
      return [...names];
    },
    async exists(p) {
      return p in files;
    },
    async remove(p) {
      delete files[p];
    },
    async importModule(p) {
      throw new Error(`no module registered for ${p}`);
    },
  };
}

/** An OpenAPI surface whose operationIds exercise Biome's natural, case-sensitive import sort
 *  (`getAgentInstructions` < `getAgenticRegistry` < `getAgentSkill`; `item2` < `item10`) — the exact
 *  collation the controller's delegate imports must reproduce to pass `organizeImports`. */
const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "guard", version: "1" },
  paths: {
    "/a": { get: { operationId: "getAgentInstructions", responses: { "200": { description: "ok" } } } },
    "/b": { get: { operationId: "getAgenticRegistry", responses: { "200": { description: "ok" } } } },
    "/c": { get: { operationId: "getAgentSkill", responses: { "200": { description: "ok" } } } },
    "/d": { get: { operationId: "item2", responses: { "200": { description: "ok" } } } },
    "/e": { get: { operationId: "item10", responses: { "200": { description: "ok" } } } },
  },
});

const BPMN = `<bpmn:process id="p" xmlns:bpmn="x" xmlns:zeebe="y"><bpmn:serviceTask id="T">` +
  `<bpmn:extensionElements><zeebe:taskDefinition type="demo.do" /></bpmn:extensionElements>` +
  `</bpmn:serviceTask></bpmn:process>`;

/** A populated app (workers + domain types + declared metadata + an API surface) and an empty app
 *  (no workers/types/messages) — together they cover both the populated (`interface X { ... }`) and
 *  the empty (`Record<string, never>`) branches of every emitter. */
const FIXTURES: Record<string, Record<string, string>> = {
  populated: {
    "/app/nano.app.json": JSON.stringify({
      id: "demo",
      data: { default: "app" },
      models: { processes: ["processes/*.bpmn"] },
      types: { greeting: { table: "greetings", fields: { who: { type: "string" } } } },
      api: { spec: "openapi.json" },
    }),
    "/app/processes/p.bpmn": BPMN,
    "/app/openapi.json": OPENAPI,
  },
  empty: {
    "/app/nano.app.json": JSON.stringify({
      id: "empty",
      data: { default: "app" },
      models: { processes: ["processes/*.bpmn"] },
    }),
    "/app/processes/p.bpmn": `<bpmn:process id="p" xmlns:bpmn="x"></bpmn:process>`,
  },
};

test("generated nano-generated/ code passes the scaffold's Biome lint ruleset", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const templateDir = join(here, "..", "..", "..", "..", "create-urban-app", "template");
  const templateBiome = JSON.parse(readFileSync(join(templateDir, "biome.json"), "utf8"));
  const biomeBin = fileURLToPath(
    await import.meta.resolve("@biomejs/biome/bin/biome"),
  );

  const work = mkdtempSync(join(tmpdir(), "urban-genlint-"));
  try {
    const dirs: string[] = [];
    let tsFileCount = 0;
    for (const [name, files] of Object.entries(FIXTURES)) {
      const io = memIO({ ...files });
      const res = await runGen({ root: "/app", io });
      const outDir = join(work, name);
      mkdirSync(outDir, { recursive: true });
      dirs.push(name);
      for (const artifact of res.artifacts) {
        if (!/\.ts$/.test(artifact.path)) continue; // .ts + .d.ts, skip .sql/.json/.md
        const fileName = artifact.path.split("/").pop();
        if (!fileName) continue;
        writeFileSync(join(outDir, fileName), io.files[`/app/${artifact.path}`]);
        tsFileCount++;
      }
    }

    // Copy the scaffold's GritQL plugin (bans `as` assertions) next to the config so its relative
    // path resolves, then reuse the template's exact ruleset — force-scoped to the generated dirs so
    // the guard tracks the scaffold standard without depending on the template's own `includes`.
    cpSync(join(templateDir, "plugins"), join(work, "plugins"), { recursive: true });
    // The guard asserts lint-rule + import-organizing (assist) cleanliness, not formatting: the
    // generated code is intentionally console/deno-styled (ADR 0053 byte-parity), which the scaffold
    // scopes away from its formatter. Disabling the formatter here mirrors that intent and keeps the
    // guard focused on the emitter's real responsibility.
    const config = {
      ...templateBiome,
      $schema: undefined,
      root: true,
      files: { includes: dirs.map((d) => `${d}/**/*.ts`) },
      formatter: { enabled: false },
      linter: { ...templateBiome.linter, includes: dirs.map((d) => `${d}/**/*.ts`) },
    };
    writeFileSync(join(work, "biome.json"), `${JSON.stringify(config, null, "\t")}\n`);

    // Run with cwd = work so Biome auto-discovers this `root: true` config (which also stops it
    // walking up into any ancestor config). Passing --config-path *and* a path under it would load
    // the config twice and error with "nested root configuration", so we rely on discovery.
    const run = spawnSync(process.execPath, [biomeBin, "check", "."], { cwd: work, encoding: "utf8" });

    // The guard is only meaningful if Biome actually inspected the generated files — a mis-scoped
    // config that silently checks nothing must not pass vacuously.
    const checked = /Checked (\d+) files/.exec(run.stdout);
    assert.ok(checked && Number(checked[1]) >= tsFileCount, `Biome did not check the generated files:\n${run.stdout}`);
    assert.equal(run.status, 0, `Biome flagged generated code:\n${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
