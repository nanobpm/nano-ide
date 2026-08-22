// Tests for the scaffolder: token substitution and the full/headless presets.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, slugify } from "./scaffold.ts";
import { main } from "./cli.ts";
import { parse as parseYaml } from "yaml";

// Single source of truth for scratch dirs: every test allocates its temp dir
// through this helper, and the module-level `after` hook removes all of them so
// no scaffold output (node_modules, generated artifacts) leaks into the OS temp
// dir across runs. Cleaning up here — rather than a per-test try/finally — keeps
// the guarantee in one place and applies it uniformly to every test.
const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function assertScaffoldedQualityGateFiles(dir: string, files: string[]): Promise<void> {
  for (const file of [
    "biome.json",
    "plugins/no-unsafe-type-assertion.grit",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(files.includes(file), `${file} in the file list`);
    assert.ok(await exists(join(dir, file)), `${file} on disk`);
  }
  assert.ok(!files.some((f) => f.startsWith("_github/")), "_github is renamed to .github");
  assert.ok(!(await exists(join(dir, "_github"))), "no _github dir on disk");
}

test("slugify normalizes names", () => {
  assert.equal(slugify("My Cool App"), "my-cool-app");
  assert.equal(slugify("  --Weird__Name!!  "), "weird-name");
  assert.equal(slugify("!!!"), "urban-app");
});

test("full preset scaffolds an opt-in ui block with the app name as its label", async () => {
  const dir = await makeTempDir("urban-ui-");
  await scaffold({ name: "Hello Urban", dir, preset: "full" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.deepEqual(manifest.ui, {
    enabled: false,
    label: "Hello Urban",
    portEnv: "PORT",
    path: "/",
  });
});

test("code-first style also scaffolds the ui block", async () => {
  const dir = await makeTempDir("urban-ui-code-");
  await scaffold({ name: "Coder", dir, style: "code" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.deepEqual(manifest.ui, {
    enabled: false,
    label: "Coder",
    portEnv: "PORT",
    path: "/",
  });
});

test("headless preset keeps the control-only ui block (enabled:false)", async () => {
  const dir = await makeTempDir("urban-ui-headless-");
  await scaffold({ name: "Batch Job", dir, preset: "headless" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.deepEqual(manifest.ui, {
    enabled: false,
    label: "Batch Job",
    portEnv: "PORT",
    path: "/",
  });
});

test("scaffolded apps default network.bind to \"all\" (0.0.0.0) so a worker fleet can reach them", async () => {
  // A fresh urban app is a server meant to be reachable by its distributed workers/agents over
  // its hostname (e.g. http://host.local:3000). Urban's runtime default is loopback (secure by
  // default), which silently makes the app unreachable off-box — the failure mode that wedged the
  // nano-workforce fleet when its liveness endpoint refused hostname connections. The scaffolder
  // therefore emits an explicit `network.bind: "all"` so new apps are reachable out of the box;
  // an operator can still tighten it to "loopback" (or override via URBAN_BIND) per deployment.
  for (const opts of [
    { name: "Full App", preset: "full" as const },
    { name: "Headless App", preset: "headless" as const },
    { name: "Code First", style: "code" as const },
  ]) {
    const dir = await makeTempDir("urban-bind-");
    await scaffold({ dir, ...opts });
    const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
    assert.deepEqual(manifest.network, { bind: "all" }, `${opts.name}: network.bind should default to "all"`);
  }
});

test("full preset scaffolds a runnable app with substituted tokens", async () => {
  const dir = await makeTempDir("urban-full-");
  const res = await scaffold({ name: "Hello Urban", dir, preset: "full" });
  assert.equal(res.id, "hello-urban");
  assert.ok(res.files.includes("nano.app.json"));
  await assertScaffoldedQualityGateFiles(dir, res.files);

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.id, "hello-urban");
  assert.equal(manifest.name, "Hello Urban");
  assert.ok(manifest.surfaces, "full keeps surfaces");
  assert.ok(manifest.triggers, "full keeps triggers");
  assert.equal(manifest.models, undefined, "deploy-by-convention: no models block");
  assert.ok(await exists(join(dir, "resources/forms")), "full keeps the resources/forms dir");
  assert.ok(res.files.includes("resources/forms/greeting.form"), "form deploys by convention");
  assert.ok(res.files.includes("resources/processes/greet.bpmn"), "process deploys by convention");

  // _gitignore is materialized as .gitignore
  assert.ok(await exists(join(dir, ".gitignore")));
});

test("full preset scaffolds the end-to-end showcase: API + operations + pages", async () => {
  const dir = await makeTempDir("urban-showcase-");
  const res = await scaffold({ name: "Hello Urban", dir, preset: "full" });

  // OpenAPI-first API surface: spec + one delegate per operationId.
  assert.ok(res.files.includes("openapi.yaml"), "scaffolds the OpenAPI spec");
  assert.ok(res.files.includes("operations/listGreetings.ts"), "listGreetings delegate");
  assert.ok(res.files.includes("operations/createGreeting.ts"), "createGreeting delegate");
  assert.ok(res.files.includes("pages/home.page.json"), "scaffolds a home page");

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.api?.spec, "openapi.yaml", "manifest declares the api binding");
  assert.equal(manifest.surfaces?.pages?.enabled, true, "pages surface enabled");

  // The spec's operationIds must each have a matching delegate module (urban check fails
  // closed otherwise), and every operation must carry a unique operationId.
  const spec = parseYaml(await readFile(join(dir, "openapi.yaml"), "utf8"));
  const opIds: string[] = [];
  const collect = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    for (const child of Object.values(v)) {
      if (child && typeof child === "object") {
        const id = Reflect.get(child, "operationId");
        if (typeof id === "string") opIds.push(id);
      }
    }
  };
  for (const item of Object.values(spec.paths)) collect(item);
  assert.deepEqual([...opIds].sort(), ["createGreeting", "listGreetings"]);
  assert.equal(new Set(opIds).size, opIds.length, "operationIds are unique");
  for (const id of opIds) {
    assert.ok(await exists(join(dir, "operations", `${id}.ts`)), `delegate for ${id}`);
  }

  // Tokens are substituted inside the spec (title) and the message-publishing delegate.
  assert.equal(spec.info.title, "Hello Urban API");
  // Every component schema is closed (`additionalProperties: false`) so generated apps reject
  // unknown request/response keys by default — a strict contract out of the box.
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    assert.ok(schema && typeof schema === "object", `schema ${name} is an object`);
    assert.equal(
      Reflect.get(schema, "additionalProperties"),
      false,
      `schema ${name} is closed (additionalProperties: false)`,
    );
  }
  const createOp = await readFile(join(dir, "operations/createGreeting.ts"), "utf8");
  assert.match(createOp, /hello-urban\.greet-requested/, "message name is substituted");
  assert.ok(!/__APP_/.test(createOp), "no un-substituted tokens remain");
});

test("scaffolds valid YAML even for names with YAML-special characters", async () => {
  // The title is substituted with a JSON-escaped value into a double-quoted YAML scalar, so
  // names containing YAML indicators (`:` + space, `#`, leading `-`, `@`, `{`, quotes, `\`)
  // must not break the authored openapi.yaml. Parse the emitted spec to prove it round-trips.
  for (const name of [
    'Foo: Bar #x',
    'My "Cool" App',
    "A\\B",
    "- leading dash",
    "@handle {x}",
  ]) {
    const dir = await makeTempDir("urban-yaml-hostile-");
    await scaffold({ name, dir, preset: "full" });
    const spec = parseYaml(await readFile(join(dir, "openapi.yaml"), "utf8"));
    assert.equal(spec.info.title, `${name} API`, `title round-trips for ${JSON.stringify(name)}`);
    // The description interpolates the name too (double-quoted scalar) — it must render the
    // real name, not a JSON-escaped form with literal backslashes (Swagger UI would show them).
    assert.ok(
      spec.info.description.includes(`The ${name} REST API.`),
      `description round-trips for ${JSON.stringify(name)}`,
    );
  }
});

test("headless preset drops surfaces, triggers and forms (workers only)", async () => {
  const dir = await makeTempDir("urban-headless-");
  const res = await scaffold({ name: "Batch Job", dir, preset: "headless" });

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.surfaces, undefined);
  assert.equal(manifest.triggers, undefined);
  assert.equal(manifest.models, undefined, "deploy-by-convention: no models block");
  assert.ok(manifest.workers, "headless keeps workers");
  assert.ok(!res.files.some((f) => f.startsWith("resources/forms/")), "no form files written");
  assert.ok(!(await exists(join(dir, "resources/forms"))), "no forms dir");

  // The human pages surface is dropped, but the machine API surface stays: a headless
  // service still exposes its REST API + Swagger docs.
  assert.ok(!res.files.some((f) => f.startsWith("pages/")), "no page files written");
  assert.ok(!(await exists(join(dir, "pages"))), "no pages dir");
  assert.equal(manifest.api?.spec, "openapi.yaml", "headless keeps the api binding");
  assert.ok(res.files.includes("openapi.yaml"), "headless keeps the spec");
  assert.ok(res.files.includes("operations/listGreetings.ts"), "headless keeps delegates");
});

test("names with quotes/backslashes/control chars stay valid JSON in the manifest", async () => {
  const dir = await makeTempDir("urban-scaffold-");
  const tricky = 'Ac "me"\\Co\tInc';
  await scaffold({ name: tricky, dir, preset: "full" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.name, tricky);
});

test("Node is the default host: no deno.json, README drops the Deno block", async () => {
  const dir = await makeTempDir("urban-node-");
  const res = await scaffold({ name: "Node App", dir });
  assert.ok(!res.files.includes("deno.json"), "no deno.json in the file list");
  assert.ok(!(await exists(join(dir, "deno.json"))), "no deno.json on disk");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(!/deno task/.test(readme), "Deno usage block is stripped");
  assert.ok(!/if:deno/.test(readme), "conditional markers are stripped");
});

test("scaffolded package.json exposes gen and gen:check scripts", async () => {
  const dir = await makeTempDir("urban-gen-");
  await scaffold({ name: "Gen App", dir });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.gen, "urban gen");
  assert.equal(pkg.scripts["gen:check"], "urban gen --check");
  assert.equal(pkg.scripts.dev, "urban dev");
});

test("Node is the default typecheck: tsc + tsconfig.json + TS toolchain devDeps", async () => {
  for (const style of ["model", "code"] as const) {
    const dir = await makeTempDir(`urban-tsc-${style}-`);
    const res = await scaffold({ name: "TS App", dir, style });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.typecheck, "tsc --noEmit", `${style}: typecheck runs tsc`);
    assert.equal(pkg.devDependencies?.typescript, "^5.6.0", `${style}: typescript devDep`);
    assert.equal(
      pkg.devDependencies?.["@types/node"],
      "^22.0.0",
      `${style}: @types/node devDep`,
    );

    assert.ok(res.files.includes("tsconfig.json"), `${style}: tsconfig.json scaffolded`);
    const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"));
    assert.equal(tsconfig.compilerOptions.noEmit, true, `${style}: tsconfig is noEmit`);
    assert.equal(
      tsconfig.compilerOptions.allowImportingTsExtensions,
      true,
      `${style}: tsconfig allows .ts import extensions`,
    );

    // The Node default needs no Deno runtime in CI.
    const ci = await readFile(join(dir, ".github/workflows/ci.yml"), "utf8");
    assert.ok(!/setup-deno/.test(ci), `${style}: CI does not install Deno`);
    assert.ok(!/if:deno/.test(ci), `${style}: CI conditional markers are resolved`);
  }
  // Model-first tsc includes generated files, so CI derives them before typechecking.
  const modelDir = await makeTempDir("urban-tsc-model-ci-");
  await scaffold({ name: "TS Model", dir: modelDir });
  const modelCi = await readFile(join(modelDir, ".github/workflows/ci.yml"), "utf8");
  assert.match(modelCi, /run: npm run gen\n\s+- run: npm run typecheck/, "gen precedes typecheck");
});

test("--deno reverts typecheck to deno check and drops the Node TS toolchain", async () => {
  for (const [style, expected] of [
    ["model", 'deno check main.ts "nano-generated/controller.ts" "workers/**/*.ts" "operations/**/*.ts"'],
    ["code", 'deno check main.ts "workflows/**/*.ts" "scripts/**/*.ts"'],
  ] as const) {
    const dir = await makeTempDir(`urban-deno-tsc-${style}-`);
    const res = await scaffold({ name: "Deno TS App", dir, style, deno: true });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.typecheck, expected, `${style}: typecheck uses deno check`);
    assert.equal(pkg.devDependencies?.typescript, undefined, `${style}: no typescript devDep`);
    assert.equal(
      pkg.devDependencies?.["@types/node"],
      undefined,
      `${style}: no @types/node devDep`,
    );

    assert.ok(!res.files.includes("tsconfig.json"), `${style}: no Node tsconfig.json`);
    assert.ok(!(await exists(join(dir, "tsconfig.json"))), `${style}: no tsconfig.json on disk`);

    // The Deno typecheck needs the Deno runtime in CI.
    const ci = await readFile(join(dir, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /setup-deno/, `${style}: CI installs Deno`);
    assert.ok(!/if:deno/.test(ci), `${style}: CI conditional markers are resolved`);
  }
});

test("scaffold wires @nanobpm/urban-testkit as a devDependency with a runnable starter test", async () => {
  for (const style of ["model", "code"] as const) {
    const dir = await makeTempDir(`urban-testkit-${style}-`);
    const res = await scaffold({ name: "Kit App", dir, style });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // The testkit ships the `assertThat*` DSL (which pulls engine-wasm ^0.7.0 in
    // transitively); pin to the current 0.12.11 release so scaffolded apps are born using the DSL.
    assert.equal(
      pkg.devDependencies?.["@nanobpm/urban-testkit"],
      "^0.12.11",
      `${style}: testkit is pinned to the assertThat* release`,
    );
    assert.equal(
      pkg.dependencies?.["@nanobpm/urban-testkit"],
      undefined,
      `${style}: testkit is NOT a runtime dependency`,
    );
    // engine-wasm must stay a transitive dep of the testkit — never pinned directly in the app.
    assert.equal(
      pkg.dependencies?.["@nanobpm/engine-wasm"],
      undefined,
      `${style}: engine-wasm is not a direct dependency`,
    );
    assert.equal(
      pkg.devDependencies?.["@nanobpm/engine-wasm"],
      undefined,
      `${style}: engine-wasm is not a direct devDependency`,
    );
    assert.equal(pkg.dependencies?.["@nanobpm/urban"], "^0.77.2", `${style}: urban pin is current`);
    assert.match(pkg.scripts.test, /node --test/, `${style}: has a test script`);

    assert.ok(
      res.files.includes("tests/engine-contract.test.ts"),
      `${style}: engine-contract starter test is scaffolded`,
    );
    const starter = await readFile(join(dir, "tests/engine-contract.test.ts"), "utf8");
    assert.match(
      starter,
      /@nanobpm\/urban-testkit/,
      `${style}: engine-contract test imports the kit`,
    );
    assert.match(
      starter,
      /runEngineClientContract/,
      `${style}: engine-contract test still runs the engine contract`,
    );

    // The e2e starter now demonstrates the fluent assertThat* DSL alongside bootTestApp.
    assert.ok(
      res.files.includes("tests/app.e2e.test.ts"),
      `${style}: e2e starter test is scaffolded`,
    );
    const e2e = await readFile(join(dir, "tests/app.e2e.test.ts"), "utf8");
    assert.match(e2e, /bootTestApp/, `${style}: e2e boots the app in-process`);
    assert.match(e2e, /assertThatInstance/, `${style}: e2e uses assertThatInstance`);
    assert.match(e2e, /assertThatDb/, `${style}: e2e uses assertThatDb`);
    assert.match(e2e, /coverage\.assertFullCoverage\(\)/, `${style}: e2e keeps the S4 coverage gate`);
  }
});

test("the model template's e2e exercises the HTTP response DSL, the code-first one drives the flow", async () => {
  const modelDir = await makeTempDir("urban-e2e-model-");
  await scaffold({ name: "Kit App", dir: modelDir, style: "model" });
  const modelE2e = await readFile(join(modelDir, "tests/app.e2e.test.ts"), "utf8");
  // The model template exposes an OpenAPI `api` binding, so its e2e asserts over HTTP responses.
  assert.match(modelE2e, /assertThatResponse/, "model e2e asserts over the HTTP response");

  const codeDir = await makeTempDir("urban-e2e-code-");
  await scaffold({ name: "Kit App", dir: codeDir, style: "code" });
  const codeE2e = await readFile(join(codeDir, "tests/app.e2e.test.ts"), "utf8");
  // The code-first template has no `api` binding, so it drives the process via createInstance.
  assert.match(codeE2e, /createInstance/, "code-first e2e starts an instance directly");
});

test("no stale testkit/urban pins remain in either scaffolded template", async () => {
  for (const [style, deno] of [
    ["model", false],
    ["model", true],
    ["code", false],
    ["code", true],
  ] as const) {
    const dir = await makeTempDir(`urban-pins-${style}-`);
    await scaffold({ name: "Pin App", dir, style, deno });
    for (const file of ["package.json", ...(deno ? ["deno.json"] : [])]) {
      const raw = await readFile(join(dir, file), "utf8");
      assert.ok(
        !/@nanobpm\/urban-testkit@?["']?\^?0\.4\.0/.test(raw),
        `${style} (deno=${deno}) ${file}: no stale ^0.4.0 testkit pin`,
      );
      assert.ok(
        !/@nanobpm\/urban@?["']?\^?0\.42\.0/.test(raw),
        `${style} (deno=${deno}) ${file}: no stale ^0.42.0 urban pin`,
      );
    }
  }
});

test("--deno maps @nanobpm/urban-testkit and adds a test task", async () => {
  const dir = await makeTempDir("urban-deno-kit-");
  await scaffold({ name: "Deno Kit App", dir, deno: true });
  const denoCfg = JSON.parse(await readFile(join(dir, "deno.json"), "utf8"));
  assert.match(
    denoCfg.imports["@nanobpm/urban-testkit"],
    /^npm:@nanobpm\/urban-testkit@/,
    "deno import maps the kit to its npm package",
  );
  assert.ok(denoCfg.tasks.test, "deno test task present");
});

test("--deno keeps deno.json and the Deno block, with markers removed", async () => {
  const dir = await makeTempDir("urban-deno-");
  const res = await scaffold({ name: "Deno App", dir, deno: true });
  assert.ok(res.files.includes("deno.json"), "deno.json in the file list");
  assert.ok(await exists(join(dir, "deno.json")), "deno.json on disk");
  const denoCfg = JSON.parse(await readFile(join(dir, "deno.json"), "utf8"));
  assert.ok(denoCfg.tasks.gen, "deno gen task present");
  assert.ok(denoCfg.tasks["gen:check"], "deno gen:check task present");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(/deno task check/.test(readme), "Deno usage block is kept");
  assert.ok(!/if:deno/.test(readme), "conditional markers are removed");
});

test("CLI tolerates a `--` end-of-options delimiter (npm create injects it)", async () => {
  const dir = await makeTempDir("urban-delim-");
  // e.g. `npm create urban-app -- "Delim App" --dir <dir> --deno`
  const code = await main(["Delim App", "--dir", dir, "--", "--deno"]);
  assert.equal(code, 0, "does not error on `--`");
  assert.ok(await exists(join(dir, "deno.json")), "--deno after `--` still applied");
});

test("code-first style scaffolds a defineFlow app (no processes/, custom main.ts)", async () => {
  const dir = await makeTempDir("urban-code-");
  const res = await scaffold({ name: "Code App", dir, style: "code" });
  assert.equal(res.id, "code-app");
  await assertScaffoldedQualityGateFiles(dir, res.files);

  // Code-first source layout: workflows/ + scripts/, no authored BPMN or worker map.
  assert.ok(res.files.includes("workflows/greet.ts"), "has a defineFlow workflow");
  assert.ok(res.files.includes("scripts/greet.ts"), "has a start script");
  assert.ok(!res.files.some((f) => f.startsWith("resources/processes/")), "no authored .bpmn");
  assert.ok(!(await exists(join(dir, "resources/processes"))), "no derived-model dir before gen");
  assert.ok(!(await exists(join(dir, "workers"))), "no workers dir");

  const flow = await readFile(join(dir, "workflows/greet.ts"), "utf8");
  assert.match(flow, /defineFlow\(/, "workflow uses defineFlow");

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.id, "code-app");
  assert.equal(manifest.name, "Code App");
  // Deploy-by-convention (ADR 0062): no `models` block. `urban gen`/`urban derive` derive from the
  // default `workflows/*.ts` and emit into `resources/processes/`, which the convention deploy +
  // codegen scan then pick up — so the scaffold needs no `models` declaration at all.
  assert.equal(manifest.models, undefined, "code-first relies on the convention (no models block)");
  assert.equal(manifest.workers, undefined, "code-first hosts workers in main.ts");

  // Code-first runs its custom entrypoint, not `urban run`.
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node --experimental-strip-types main.ts");
  assert.equal(pkg.scripts.greet, "node --experimental-strip-types scripts/greet.ts");
  assert.equal(pkg.scripts.check, "urban check", "still validates via the urban CLI");

  const mainTs = await readFile(join(dir, "main.ts"), "utf8");
  assert.match(mainTs, /WorkflowClient/, "main deploys via WorkflowClient");
  assert.match(mainTs, /new Worker\(/, "main hosts an in-process Worker");
});

test("--code-first flag selects the code-first template", async () => {
  const dir = await makeTempDir("urban-cf-flag-");
  const code = await main(["CF App", "--dir", dir, "--code-first"]);
  assert.equal(code, 0);
  assert.ok(await exists(join(dir, "workflows/greet.ts")), "code-first workflow scaffolded");
  assert.ok(!(await exists(join(dir, "processes"))), "no processes dir");
});

test("--style code is equivalent, and --style rejects unknown values", async () => {
  const dir = await makeTempDir("urban-style-");
  const code = await main(["Styled App", "--dir", dir, "--style", "code"]);
  assert.equal(code, 0);
  assert.ok(await exists(join(dir, "workflows/greet.ts")), "--style code scaffolds code-first");

  await assert.rejects(
    () => main(["Bad Style", "--dir", dir, "--style", "graph"]),
    /--style must be "model" or "code"/,
  );
});

test("--code-first --deno keeps deno.json with node-run start/dev/greet tasks", async () => {
  const dir = await makeTempDir("urban-cf-deno-");
  const res = await scaffold({ name: "CF Deno", dir, style: "code", deno: true });
  assert.ok(res.files.includes("deno.json"), "deno.json emitted");
  const denoCfg = JSON.parse(await readFile(join(dir, "deno.json"), "utf8"));
  assert.equal(denoCfg.tasks.start, "deno run -A main.ts");
  assert.equal(denoCfg.tasks.greet, "deno run -A scripts/greet.ts");
  assert.ok(denoCfg.tasks.check, "deno check task present");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(/deno task/.test(readme), "Deno block kept");
  assert.ok(!/if:deno/.test(readme), "conditional markers removed");
});
