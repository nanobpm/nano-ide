import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeContext } from "../context.ts";
import type { HostContext } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { deployModels } from "./deploy.ts";

const ROOT = "/app";

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

interface DeployedResource {
  name: string;
  content: string;
  contentType: string;
}

interface Harness {
  ctx: RuntimeContext;
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  deployed: DeployedResource[];
}

/** A virtual-filesystem host over `files` (keyed by absolute path) plus a recording engine. The
 *  host implements `listDir` (files under a dir) and `listSubdirs` (immediate sub-directories), so
 *  the convention walk (`resources/*` + `resources/<subdir>/*`) can be exercised. */
function makeHarness(files: Record<string, string>, manifest: Partial<AppManifest>): Harness {
  const logs: Harness["logs"] = [];
  const deployed: DeployedResource[] = [];
  const dirsUnder = (dir: string): Set<string> => {
    const out = new Set<string>();
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) out.add(rest.slice(0, slash));
    }
    return out;
  };
  // biome-ignore lint/plugin: HostContext test double implementing only the fs/log members deployModels exercises; the rest are intentionally absent.
  const host: HostContext = {
    runtime: "node",
    log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) =>
      logs.push({ level, msg, fields }),
    exists: async (p: string) =>
      p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    readTextFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listDir: async (dir: string) =>
      Object.keys(files)
        .filter((f) => dirname(f) === dir)
        .map((f) => f.slice(f.lastIndexOf("/") + 1)),
    listSubdirs: async (dir: string) => [...dirsUnder(dir)],
  } as unknown as HostContext;
  const engine = {
    deployResources: async (resources: DeployedResource[]) => {
      deployed.push(...resources);
      return { deployed: resources.length };
    },
  };
  // biome-ignore lint/plugin: RuntimeContext test double assembled from the mock host/engine/manifest below for deployModels.
  const ctx = {
    root: ROOT,
    // biome-ignore lint/plugin: inline AppManifest fixture — a Partial<AppManifest> spread over the required base fields.
    manifest: { schemaVersion: 1, id: "t", name: "T", ...manifest } as AppManifest,
    // biome-ignore lint/plugin: EngineClient test double implementing only deployResources (the sole method deployModels calls).
    engine: engine as unknown as RuntimeContext["engine"],
    host,
  } as unknown as RuntimeContext;
  return { ctx, logs, deployed };
}

// ── models.* override (explicit globs, unchanged behavior) ───────────────────

test("deployModels uses the manifest models globs when declared, keyed by basename", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/processes/agent.bpmn": "<x/>",
      "/app/forms/greet.form": "{}",
      "/app/resources/ignored.bpmn": "<should-not-deploy/>",
    },
    { models: { processes: ["processes/*.bpmn"], forms: ["forms/*.form"] } },
  );
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 2);
  const byName = Object.fromEntries(deployed.map((d) => [d.name, d]));
  assert.equal(byName["agent.bpmn"].contentType, "text/xml");
  assert.equal(byName["greet.form"].contentType, "application/json");
  // With an explicit override, the convention `resources/` walk is skipped entirely.
  assert.ok(!deployed.some((d) => d.name === "ignored.bpmn"));
});

test("deployModels deploys content verbatim (no {{name}} substitution remains)", async () => {
  const { ctx, deployed } = makeHarness(
    { "/app/processes/agent.bpmn": '<x value="{{review}}" />' },
    { models: { processes: ["processes/*.bpmn"] } },
  );
  await deployModels(ctx);
  assert.equal(deployed[0].content, '<x value="{{review}}" />');
});

test("deployModels treats a declared-but-empty models block as an override, not convention", async () => {
  // A present `models` block that resolves to zero files is an explicit override: it must NOT
  // silently fall back to the `resources/` convention walk (would deploy resources the author
  // never opted into). Keyed off the block's *presence*, not an empty pattern set.
  const { ctx, deployed, logs } = makeHarness(
    { "/app/resources/order.bpmn": "<should-not-deploy/>" },
    { models: { processes: [] } },
  );
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 0);
  assert.deepEqual(deployed, []);
  // No-model-files log (override path), NOT the "no resources found by convention" log.
  assert.ok(logs.some((l) => l.msg.includes("no model files matched")));
  assert.ok(!logs.some((l) => l.msg.includes("no resources found by convention")));
});

// ── deploy-by-convention (no models declared) ────────────────────────────────

test("deployModels discovers resources/ by convention when no models are declared", async () => {
  const { ctx, deployed, logs } = makeHarness(
    {
      "/app/resources/order.bpmn": "<p/>",
      "/app/resources/decide.dmn": "<d/>",
      "/app/resources/prompts/review.md": "Do the review",
      "/app/resources/forms/greet.form": "{}",
      // Docs live OUTSIDE resources/ and must never deploy.
      "/app/docs/guide.md": "# docs",
      "/app/AGENTS.md": "# agents",
      "/app/README.md": "# readme",
    },
    {},
  );
  const res = await deployModels(ctx);
  const names = deployed.map((d) => d.name).sort();
  assert.deepEqual(names, ["decide.dmn", "greet.form", "order.bpmn", "review.md"]);
  assert.equal(res.deployed, 4);
  // A prompt (.md under resources/) is a GenericScript resource → octet-stream content type.
  const prompt = deployed.find((d) => d.name === "review.md");
  assert.equal(prompt?.contentType, "application/octet-stream");
  assert.equal(prompt?.content, "Do the review");
  assert.ok(logs.some((l) => l.fields?.byConvention === true));
});

test("deployModels convention walk is shallow — one level deep only", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/resources/top.bpmn": "<a/>",
      "/app/resources/sub/one.bpmn": "<b/>",
      // Two levels deep: NOT swept in (shallow-by-convention).
      "/app/resources/sub/deeper/two.bpmn": "<c/>",
    },
    {},
  );
  await deployModels(ctx);
  const names = deployed.map((d) => d.name).sort();
  assert.deepEqual(names, ["one.bpmn", "top.bpmn"]);
});

test("deployModels errors on a basename collision across resources/ subdirs", async () => {
  const { ctx } = makeHarness(
    {
      "/app/resources/a/order.bpmn": "<a/>",
      "/app/resources/b/order.bpmn": "<b/>",
    },
    {},
  );
  await assert.rejects(deployModels(ctx), /basename collision/);
});

test("deployModels errors on a basename collision under an explicit override too", async () => {
  const { ctx } = makeHarness(
    {
      "/app/processes/order.bpmn": "<a/>",
      "/app/extra/order.bpmn": "<b/>",
    },
    { models: { processes: ["processes/*.bpmn", "extra/*.bpmn"] } },
  );
  await assert.rejects(deployModels(ctx), /basename collision/);
});

test("deployModels is a no-op when resources/ is empty and no models are declared", async () => {
  const { ctx, deployed, logs } = makeHarness({ "/app/docs/x.md": "y" }, {});
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 0);
  assert.deepEqual(deployed, []);
  assert.ok(logs.some((l) => l.msg.includes("no resources found by convention")));
});
