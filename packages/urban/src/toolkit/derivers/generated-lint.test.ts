import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGen, type GenIO } from "../gen.ts";
import {
  emitDomainBindings,
  emitDomainDts,
  emitDomainModel,
  type SourceSchema,
} from "./domain.ts";
import { emitMeta } from "./meta.ts";
import { emitMessageBindings, emitMessageBindingsRuntime } from "./messages.ts";
import { emitWorkerBindings, emitWorkerBindingsRuntime } from "./worker-io.ts";
import { emitApiBindings, emitApiController } from "./api.ts";
import type { OpenApiDoc } from "../../openapi/spec.ts";

// These guards spawn the scaffold's Biome *via Node* (`process.execPath <biome> check`). Under
// `npm run test:deno` `process.execPath` is the Deno binary, so that spawn would launch Deno rather
// than Biome and the lint command would fail spuriously. The generated output is runtime-independent
// (it's plain text the emitters produce identically under either runtime), so running this guard once
// under Node is sufficient — skip it under Deno instead of mis-spawning.
const runtimeIsNode = !("Deno" in globalThis);
const nodeOnly = {
  skip: runtimeIsNode ? false : "Node-only: spawns Biome via process.execPath (Deno's execPath is not Node)",
};

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
 *  collation the controller's delegate imports must reproduce to pass `organizeImports`. The
 *  path→operationId assignment is deliberately *scrambled* relative to that collation: `collectOperations`
 *  yields ops in sorted-path order (`/a`…`/e`), so the emitter's own `naturalCompare` sort — not the
 *  input order — is what must reorder the imports into Biome's canonical sequence. A broken/removed
 *  sort would leave them in path order and fail the `organizeImports` assist, so this input actually
 *  regression-guards `naturalCompare` rather than passing on already-sorted data. */
const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "guard", version: "1" },
  paths: {
    "/a": { get: { operationId: "item10", responses: { "200": { description: "ok" } } } },
    "/b": { get: { operationId: "getAgentSkill", responses: { "200": { description: "ok" } } } },
    "/c": { get: { operationId: "getAgentInstructions", responses: { "200": { description: "ok" } } } },
    "/d": { get: { operationId: "getAgenticRegistry", responses: { "200": { description: "ok" } } } },
    "/e": { get: { operationId: "item2", responses: { "200": { description: "ok" } } } },
  },
});

const BPMN = `<bpmn:process id="p" xmlns:bpmn="x" xmlns:zeebe="y"><bpmn:serviceTask id="T">` +
  `<bpmn:extensionElements><zeebe:taskDefinition type="demo.do" /></bpmn:extensionElements>` +
  `</bpmn:serviceTask></bpmn:process>`;

/** A populated app (workers + domain types + declared metadata + an API surface) and an empty app
 *  (no workers/types/messages) — together they cover both the populated (`interface X { ... }`) and
 *  the empty (`Record<never, never>`) branches of every emitter reachable through `runGen`. */
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

/** Resolve the scaffold's own Biome binary — the exact linter a scaffolded app runs. */
async function resolveBiomeBin(): Promise<string> {
  return fileURLToPath(await import.meta.resolve("@biomejs/biome/bin/biome"));
}

/** Lint `dirs` under `work` with the scaffold template's *exact* ruleset (plugin included), scoped
 *  to the generated dirs and with the formatter disabled — the generated code is intentionally
 *  console/deno-styled (ADR 0053 byte-parity), which the scaffold scopes away from its formatter, so
 *  the guard tracks lint-rule + import-organizing (assist) cleanliness only. */
function lintUnderScaffold(
  work: string,
  templateDir: string,
  biomeBin: string,
  dirs: string[],
): { status: number | null; stdout: string; stderr: string } {
  const templateBiome = JSON.parse(readFileSync(join(templateDir, "_biome.json"), "utf8"));
  // Copy the scaffold's GritQL plugin (bans `as` assertions) next to the config so its relative
  // path resolves, then reuse the template's exact ruleset — force-scoped to the generated dirs so
  // the guard tracks the scaffold standard without depending on the template's own `includes`.
  cpSync(join(templateDir, "plugins"), join(work, "plugins"), { recursive: true });
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
  return spawnSync(process.execPath, [biomeBin, "check", "."], { cwd: work, encoding: "utf8" });
}

test("generated nano-generated/ code passes the scaffold's Biome lint ruleset", nodeOnly, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const templateDir = join(here, "..", "..", "..", "..", "create-urban-app", "template");
  const biomeBin = await resolveBiomeBin();

  const work = mkdtempSync(join(tmpdir(), "urban-genlint-"));
  try {
    const dirs: string[] = [];
    const perFixture: Record<string, number> = {};
    let tsFileCount = 0;
    for (const [name, files] of Object.entries(FIXTURES)) {
      const io = memIO({ ...files });
      const res = await runGen({ root: "/app", io });
      const outDir = join(work, name);
      mkdirSync(outDir, { recursive: true });
      dirs.push(name);
      perFixture[name] = 0;
      for (const artifact of res.artifacts) {
        if (!/\.ts$/.test(artifact.path)) continue; // .ts + .d.ts, skip .sql/.json/.md
        const fileName = artifact.path.split("/").pop();
        if (!fileName) continue;
        writeFileSync(join(outDir, fileName), io.files[`/app/${artifact.path}`]);
        perFixture[name]++;
        tsFileCount++;
      }
    }

    // A fixture that silently produced no TypeScript artifacts would make the whole guard vacuous
    // (Biome would report `Checked 0 files` yet still satisfy `>= 0`). Assert each fixture emitted a
    // nonzero set *before* trusting Biome's own file count.
    for (const [name, count] of Object.entries(perFixture)) {
      assert.ok(count > 0, `fixture "${name}" produced no TypeScript artifacts — the guard is vacuous`);
    }

    const run = lintUnderScaffold(work, templateDir, biomeBin, dirs);

    // The guard is only meaningful if Biome actually inspected the generated files — a mis-scoped
    // config that silently checks nothing must not pass vacuously.
    const checked = /Checked (\d+) files/.exec(run.stdout);
    assert.ok(checked && Number(checked[1]) >= tsFileCount, `Biome did not check the generated files:\n${run.stdout}`);
    assert.equal(run.status, 0, `Biome flagged generated code:\n${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("every emitter branch (populated, empty, and the data-path runtime wrappers) is lint-clean", nodeOnly, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const templateDir = join(here, "..", "..", "..", "..", "create-urban-app", "template");
  const biomeBin = await resolveBiomeBin();

  // `runGen` emits only the `*.d.ts` type maps + the API runtime. The *data path* (`urban data`,
  // `dataops.ts`) additionally materializes the runtime wrappers `workers.ts`, `messages.ts`, and the
  // single-/multi-source `domain.ts` bindings into `nano-generated/`, so the scaffold's
  // `nano-generated/**/*.ts` lint scope covers them too. Those wrappers carry the pass-through
  // `as`-casts (and, multi-source, a keyed accessor) that only this plugin/assist ruleset can catch —
  // exercise them here alongside every populated and empty (`Record<never, never>`) emitter branch so
  // a regression in any of them fails at this guard, not only in a scaffolded user's project.
  const sources: SourceSchema[] = [
    {
      source: "app",
      tables: [{
        name: "customers",
        kind: "table",
        columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
        indexes: [],
        foreignKeys: [],
      }],
    },
    {
      source: "analytics",
      tables: [{
        name: "events",
        kind: "table",
        columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
        indexes: [],
        foreignKeys: [],
      }],
    },
  ];

  // An empty OpenAPI document (zero operations) → the empty-branch of the API emitters.
  const EMPTY_SPEC: OpenApiDoc = { openapi: "3.0.0", info: { title: "empty", version: "1" }, paths: {} };

  const files: Record<string, string> = {
    // data-path runtime wrappers (the `as`-cast / keyed-accessor carriers):
    "workers.ts": emitWorkerBindingsRuntime(),
    "messages.ts": emitMessageBindingsRuntime(),
    "domain-single.ts": emitDomainBindings([sources[0]], "app"),
    "domain-multi.ts": emitDomainBindings(sources, "app"),
    // populated emitter branches:
    "worker-io-populated.d.ts": emitWorkerBindings(
      [{ taskType: "review", inputType: "Order", outputType: "Order", headerKeys: ["priority", "x-flag"] }],
      ["Order"],
    ),
    "message-io-populated.d.ts": emitMessageBindings([{ messageName: "approved", inputType: "Order" }], ["Order"]),
    "meta-populated.ts": emitMeta([
      { key: "classification", value: "internal" },
      { key: "data-classification", value: "pii" },
    ]),
    "domain-rows-populated.d.ts": emitDomainModel(sources, "app", {
      greeting: { fields: { who: { type: "string" } } },
      EmptyThing: { fields: {} }, // a declared type with no fields → the `Record<never, never>` registry fallback
    }),
    // empty emitter branches (the `Record<never, never>` fallbacks):
    "worker-io-empty.d.ts": emitWorkerBindings([], []),
    "message-io-empty.d.ts": emitMessageBindings([], []),
    "meta-empty.ts": emitMeta([]),
    "domain-rows-empty.d.ts": emitDomainDts([]),
    // a *multi-source* schema where one source has NO tables → the multi-source empty-source
    // `Record<never, never>` fallback in `emitDomainDtsForSources` (domain.ts), which the
    // single-/no-source `emitDomainDts([])` above never reaches:
    "domain-rows-empty-source.d.ts": emitDomainModel([sources[0], { source: "audit", tables: [] }], "app", {}),
    // an empty OpenAPI spec (zero operations) → the `ApiOperations = Record<never, never>` fallback
    // (not an empty `interface`) and a delegate-less controller:
    "api-io-empty.d.ts": emitApiBindings(EMPTY_SPEC),
    "operations-empty.ts": emitApiController(EMPTY_SPEC),
  };

  const work = mkdtempSync(join(tmpdir(), "urban-genwrap-"));
  try {
    const outDir = join(work, "gen");
    mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);

    const run = lintUnderScaffold(work, templateDir, biomeBin, ["gen"]);

    const expected = Object.keys(files).length;
    const checked = /Checked (\d+) files/.exec(run.stdout);
    assert.ok(
      checked && Number(checked[1]) >= expected,
      `Biome did not check every branch/wrapper file (expected >= ${expected}):\n${run.stdout}`,
    );
    assert.equal(run.status, 0, `Biome flagged a generated emitter branch:\n${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/** Lint files laid out at `nano-generated/` using the template's `biome.json` *as shipped* — its own
 *  `files`/`linter.includes` and its formatter (enabled, with the `!nano-generated/**` exclusion),
 *  only flipping `root` (so Biome doesn't discover the monorepo's root config) and dropping the
 *  node_modules-relative `$schema`. Scoping the check to `nano-generated` lets Biome discover this
 *  config from `cwd` while checking only the generated tree. `lintUnderScaffold` above deliberately
 *  re-scopes `includes` and disables the formatter, so it can't catch a template regression that drops
 *  the `nano-generated/**` lint include or the formatter's `!nano-generated/**` exclusion — this can. */
function lintWithTemplateConfigVerbatim(
  work: string,
  templateDir: string,
  biomeBin: string,
): { status: number | null; stdout: string; stderr: string } {
  const templateBiome = JSON.parse(readFileSync(join(templateDir, "_biome.json"), "utf8"));
  cpSync(join(templateDir, "plugins"), join(work, "plugins"), { recursive: true });
  const config = { ...templateBiome, $schema: undefined, root: true };
  writeFileSync(join(work, "biome.json"), `${JSON.stringify(config, null, "\t")}\n`);
  return spawnSync(process.execPath, [biomeBin, "check", "nano-generated"], { cwd: work, encoding: "utf8" });
}

test("both scaffold templates lint (and format-exclude) nano-generated/ code with their biome.json as shipped", nodeOnly, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const biomeBin = await resolveBiomeBin();

  // Deliberately console/deno-styled (2-space, quoted keys, `as`-cast carriers) generated output: it
  // is lint-clean under the scaffold ruleset yet *not* Biome's default (tab) format — so if a template
  // ever dropped its formatter `!nano-generated/**` exclusion, `biome check` would report a format diff
  // here and fail, and if it dropped the `nano-generated/**` lint include Biome would check 0 files.
  const generated: Record<string, string> = {
    "workers.ts": emitWorkerBindingsRuntime(),
    "messages.ts": emitMessageBindingsRuntime(),
  };

  for (const template of ["template", "template-code-first"]) {
    const templateDir = join(here, "..", "..", "..", "..", "create-urban-app", template);
    const work = mkdtempSync(join(tmpdir(), `urban-tmpl-${template}-`));
    try {
      const genDir = join(work, "nano-generated");
      mkdirSync(genDir, { recursive: true });
      for (const [name, content] of Object.entries(generated)) writeFileSync(join(genDir, name), content);

      const run = lintWithTemplateConfigVerbatim(work, templateDir, biomeBin);

      // The template's own `nano-generated/**/*.ts` include must actually pick the files up — a
      // dropped include would leave Biome checking 0 files while still exiting 0 (vacuous pass).
      const checked = /Checked (\d+) files/.exec(run.stdout);
      assert.ok(
        checked && Number(checked[1]) >= Object.keys(generated).length,
        `[${template}] template biome.json did not lint nano-generated/ via its own includes:\n${run.stdout}`,
      );
      assert.equal(
        run.status,
        0,
        `[${template}] template biome.json flagged (lint) or reformatted generated code:\n${run.stdout}\n${run.stderr}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});
