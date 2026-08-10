// Tests for the scaffolder: token substitution and the full/headless presets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, slugify } from "./scaffold.ts";
import { main } from "./cli.ts";
import { parse as parseYaml } from "yaml";

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
  const dir = await mkdtemp(join(tmpdir(), "urban-ui-"));
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
  const dir = await mkdtemp(join(tmpdir(), "urban-ui-code-"));
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
  const dir = await mkdtemp(join(tmpdir(), "urban-ui-headless-"));
  await scaffold({ name: "Batch Job", dir, preset: "headless" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.deepEqual(manifest.ui, {
    enabled: false,
    label: "Batch Job",
    portEnv: "PORT",
    path: "/",
  });
});

test("full preset scaffolds a runnable app with substituted tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-full-"));
  const res = await scaffold({ name: "Hello Urban", dir, preset: "full" });
  assert.equal(res.id, "hello-urban");
  assert.ok(res.files.includes("nano.app.json"));
  await assertScaffoldedQualityGateFiles(dir, res.files);

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.id, "hello-urban");
  assert.equal(manifest.name, "Hello Urban");
  assert.ok(manifest.surfaces, "full keeps surfaces");
  assert.ok(manifest.triggers, "full keeps triggers");
  assert.ok(manifest.models.forms, "full keeps form models");
  assert.ok(await exists(join(dir, "forms")), "full keeps the forms dir");

  // _gitignore is materialized as .gitignore
  assert.ok(await exists(join(dir, ".gitignore")));
});

test("full preset scaffolds the end-to-end showcase: API + operations + pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-showcase-"));
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
    const dir = await mkdtemp(join(tmpdir(), "urban-yaml-hostile-"));
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
  const dir = await mkdtemp(join(tmpdir(), "urban-headless-"));
  const res = await scaffold({ name: "Batch Job", dir, preset: "headless" });

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.surfaces, undefined);
  assert.equal(manifest.triggers, undefined);
  assert.equal(manifest.models?.forms, undefined);
  assert.ok(manifest.workers, "headless keeps workers");
  assert.ok(!res.files.some((f) => f.startsWith("forms/")), "no form files written");
  assert.ok(!(await exists(join(dir, "forms"))), "no forms dir");

  // The human pages surface is dropped, but the machine API surface stays: a headless
  // service still exposes its REST API + Swagger docs.
  assert.ok(!res.files.some((f) => f.startsWith("pages/")), "no page files written");
  assert.ok(!(await exists(join(dir, "pages"))), "no pages dir");
  assert.equal(manifest.api?.spec, "openapi.yaml", "headless keeps the api binding");
  assert.ok(res.files.includes("openapi.yaml"), "headless keeps the spec");
  assert.ok(res.files.includes("operations/listGreetings.ts"), "headless keeps delegates");
});

test("names with quotes/backslashes/control chars stay valid JSON in the manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-scaffold-"));
  const tricky = 'Ac "me"\\Co\tInc';
  await scaffold({ name: tricky, dir, preset: "full" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.name, tricky);
});

test("Node is the default host: no deno.json, README drops the Deno block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-node-"));
  const res = await scaffold({ name: "Node App", dir });
  assert.ok(!res.files.includes("deno.json"), "no deno.json in the file list");
  assert.ok(!(await exists(join(dir, "deno.json"))), "no deno.json on disk");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(!/deno task/.test(readme), "Deno usage block is stripped");
  assert.ok(!/if:deno/.test(readme), "conditional markers are stripped");
});

test("scaffolded package.json exposes gen and gen:check scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-gen-"));
  await scaffold({ name: "Gen App", dir });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.gen, "urban gen");
  assert.equal(pkg.scripts["gen:check"], "urban gen --check");
  assert.equal(pkg.scripts.dev, "urban dev");
});

test("scaffold wires @nanobpm/urban-testkit as a devDependency with a runnable starter test", async () => {
  for (const style of ["model", "code"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `urban-testkit-${style}-`));
    const res = await scaffold({ name: "Kit App", dir, style });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.ok(
      pkg.devDependencies?.["@nanobpm/urban-testkit"],
      `${style}: testkit is a devDependency`,
    );
    assert.equal(
      pkg.dependencies?.["@nanobpm/urban-testkit"],
      undefined,
      `${style}: testkit is NOT a runtime dependency`,
    );
    assert.match(pkg.scripts.test, /node --test/, `${style}: has a test script`);

    assert.ok(
      res.files.includes("tests/engine-contract.test.ts"),
      `${style}: starter test is scaffolded`,
    );
    const starter = await readFile(join(dir, "tests/engine-contract.test.ts"), "utf8");
    assert.match(
      starter,
      /@nanobpm\/urban-testkit/,
      `${style}: starter test imports the kit`,
    );
  }
});

test("--deno maps @nanobpm/urban-testkit and adds a test task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-deno-kit-"));
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
  const dir = await mkdtemp(join(tmpdir(), "urban-deno-"));
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
  const dir = await mkdtemp(join(tmpdir(), "urban-delim-"));
  // e.g. `npm create urban-app -- "Delim App" --dir <dir> --deno`
  const code = await main(["Delim App", "--dir", dir, "--", "--deno"]);
  assert.equal(code, 0, "does not error on `--`");
  assert.ok(await exists(join(dir, "deno.json")), "--deno after `--` still applied");
});

test("code-first style scaffolds a defineFlow app (no processes/, custom main.ts)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-code-"));
  const res = await scaffold({ name: "Code App", dir, style: "code" });
  assert.equal(res.id, "code-app");
  await assertScaffoldedQualityGateFiles(dir, res.files);

  // Code-first source layout: workflows/ + scripts/, no authored BPMN or worker map.
  assert.ok(res.files.includes("workflows/greet.ts"), "has a defineFlow workflow");
  assert.ok(res.files.includes("scripts/greet.ts"), "has a start script");
  assert.ok(!res.files.some((f) => f.startsWith("processes/")), "no processes/*.bpmn");
  assert.ok(!(await exists(join(dir, "processes"))), "no processes dir");
  assert.ok(!(await exists(join(dir, "workers"))), "no workers dir");

  const flow = await readFile(join(dir, "workflows/greet.ts"), "utf8");
  assert.match(flow, /defineFlow\(/, "workflow uses defineFlow");

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.id, "code-app");
  assert.equal(manifest.name, "Code App");
  // Self-describing: declares the code-first workflow source + where derived models land,
  // so `urban gen`/`urban derive` and standalone (non-console) tooling need no defaults.
  assert.ok(manifest.models, "code-first declares a models block");
  assert.deepEqual(manifest.models.workflows, ["workflows/*.ts"], "declares the workflow source");
  assert.deepEqual(manifest.models.processes, ["processes/*.bpmn"], "declares the derived model dir");
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
  const dir = await mkdtemp(join(tmpdir(), "urban-cf-flag-"));
  const code = await main(["CF App", "--dir", dir, "--code-first"]);
  assert.equal(code, 0);
  assert.ok(await exists(join(dir, "workflows/greet.ts")), "code-first workflow scaffolded");
  assert.ok(!(await exists(join(dir, "processes"))), "no processes dir");
});

test("--style code is equivalent, and --style rejects unknown values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-style-"));
  const code = await main(["Styled App", "--dir", dir, "--style", "code"]);
  assert.equal(code, 0);
  assert.ok(await exists(join(dir, "workflows/greet.ts")), "--style code scaffolds code-first");

  await assert.rejects(
    () => main(["Bad Style", "--dir", dir, "--style", "graph"]),
    /--style must be "model" or "code"/,
  );
});

test("--code-first --deno keeps deno.json with node-run start/dev/greet tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-cf-deno-"));
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
