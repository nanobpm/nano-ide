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
 *  the recursive convention walk (every file under `resources/` at any depth) can be exercised. */
function makeHarness(
  files: Record<string, string>,
  manifest: Partial<AppManifest>,
  engineOverride?: { deployResources: (r: DeployedResource[]) => Promise<{ deployed: number }> },
): Harness {
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
  const engine = engineOverride ?? {
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
  // Convention resources are keyed by their path RELATIVE to resources/ (POSIX), not the basename.
  const names = deployed.map((d) => d.name).sort();
  assert.deepEqual(names, ["decide.dmn", "forms/greet.form", "order.bpmn", "prompts/review.md"]);
  assert.equal(res.deployed, 4);
  // A prompt (.md under resources/) is a generic resource content-typed text/markdown, deployed
  // verbatim and keyed by its relative-path resourceId.
  const prompt = deployed.find((d) => d.name === "prompts/review.md");
  assert.equal(prompt?.contentType, "text/markdown");
  assert.equal(prompt?.content, "Do the review");
  assert.ok(logs.some((l) => l.fields?.byConvention === true));
});

test("deployModels convention walk is recursive — every file at any depth", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/resources/top.bpmn": "<a/>",
      "/app/resources/sub/one.bpmn": "<b/>",
      // Two levels deep: now swept in (recursive-by-convention, issue #231).
      "/app/resources/sub/deeper/two.bpmn": "<c/>",
    },
    {},
  );
  await deployModels(ctx);
  const names = deployed.map((d) => d.name).sort();
  assert.deepEqual(names, ["sub/deeper/two.bpmn", "sub/one.bpmn", "top.bpmn"]);
});

test("deployModels keys same-named files in different subdirs as distinct relative-path resources", async () => {
  // resources/a/x.md and resources/b/x.md share a basename but deploy as distinct resourceIds —
  // no collision (issue #231).
  const { ctx, deployed } = makeHarness(
    {
      "/app/resources/a/order.md": "<a/>",
      "/app/resources/b/order.md": "<b/>",
    },
    {},
  );
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 2);
  const byName = Object.fromEntries(deployed.map((d) => [d.name, d]));
  assert.equal(byName["a/order.md"].content, "<a/>");
  assert.equal(byName["b/order.md"].content, "<b/>");
});

test("deployModels infers a content type per extension for generic resources", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/resources/prompts/plan.md": "# plan",
      "/app/resources/data/config.json": "{}",
      "/app/resources/notes/readme.txt": "hi",
      "/app/resources/bin/blob.rpa": "\u0000binary",
    },
    {},
  );
  await deployModels(ctx);
  const byName = Object.fromEntries(deployed.map((d) => [d.name, d]));
  assert.equal(byName["prompts/plan.md"].contentType, "text/markdown");
  assert.equal(byName["data/config.json"].contentType, "application/json");
  assert.equal(byName["notes/readme.txt"].contentType, "text/plain");
  // Unknown extension → octet-stream, deployed verbatim (never mislabelled/mangled).
  assert.equal(byName["bin/blob.rpa"].contentType, "application/octet-stream");
  assert.equal(byName["bin/blob.rpa"].content, "\u0000binary");
});

test("deployModels deploys a generic resource verbatim (no {{token}} substitution)", async () => {
  const { ctx, deployed } = makeHarness(
    { "/app/resources/prompts/review.md": "Review {{pr}} carefully" },
    {},
  );
  await deployModels(ctx);
  assert.equal(deployed[0].content, "Review {{pr}} carefully");
});

test("deployModels redeploy is idempotent per resourceId+content, new content bumps the version", async () => {
  // Model the engine's name+checksum duplicate rule: identical resourceId+content is skipped (no
  // version bump); changed content advances the latest pointer (issue #231 acceptance).
  const versions = new Map<string, string[]>();
  const engine = {
    deployResources: async (resources: DeployedResource[]) => {
      let deployed = 0;
      for (const r of resources) {
        const history = versions.get(r.name) ?? [];
        if (history[history.length - 1] !== r.content) {
          history.push(r.content);
          versions.set(r.name, history);
          deployed++;
        }
      }
      return { deployed };
    },
  };
  const files: Record<string, string> = { "/app/resources/prompts/plan.md": "v1" };
  const mk = () => makeHarness(files, {}, engine).ctx;
  assert.equal((await deployModels(mk())).deployed, 1); // first deploy → v1
  assert.equal((await deployModels(mk())).deployed, 0); // unchanged → no-op
  files["/app/resources/prompts/plan.md"] = "v2";
  assert.equal((await deployModels(mk())).deployed, 1); // changed → new version
  assert.deepEqual(versions.get("prompts/plan.md"), ["v1", "v2"]);
});

test("deployModels errors on a basename collision under an explicit override", async () => {
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
