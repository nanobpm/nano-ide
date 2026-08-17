// Tests for the app-scoped institutional-memory brief surface (ADR 0060 §2): `/app/agent` +
// `/app/agent.json` read through to the `urban gen`-derived `nano-generated/system-brief.*`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAgent } from "./agent.ts";
import type { RuntimeContext } from "../context.ts";
import type { EngineClient, HostContext, HttpRequest, HttpResponse } from "../host.ts";

const fakeEngine: EngineClient = {
  deployResources: async () => ({ deployed: 0 }),
  createInstance: async () => ({ processInstanceKey: "pi" }),
  cancelInstance: async () => {},
  publishMessage: async () => {},
  searchUserTasks: async () => [],
  openUserTasks: async () => [],
  getForm: async () => null,
  completeUserTask: async () => {},
  searchProcessInstances: async () => [],
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

/** A RuntimeContext whose host resolves a fixed set of files (a missing path throws, like a real
 *  file port). Only the fields `mountAgent` touches are populated. */
function ctxWithFiles(files: Record<string, string>): RuntimeContext {
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listDir: async () => [],
    exists: async (p: string) => p in files,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
  return { root: ".", manifest: { schemaVersion: 1, id: "app", name: "App" }, host, engine: fakeEngine };
}

async function call(route: { handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> }): Promise<HttpResponse> {
  return route.handler({
    method: "GET",
    path: "/",
    query: new URLSearchParams(),
    headers: new Headers(),
    text: async () => "",
  });
}

const routeAt = (ctx: RuntimeContext, path: string) => {
  const r = mountAgent(ctx).routes.find((x) => x.path === path);
  assert.ok(r, `expected an ${path} route`);
  return r;
};

test("GET /app/agent serves the derived system-brief.md as markdown", async () => {
  const ctx = ctxWithFiles({ "./nano-generated/system-brief.md": "# App — system brief\n" });
  const res = await call(routeAt(ctx, "/app/agent"));
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /text\/markdown/);
  assert.equal(res.body, "# App — system brief\n");
});

test("GET /app/agent.json serves the derived system-brief.json verbatim", async () => {
  const payload = '{\n  "app": "App",\n  "processes": ["p"]\n}\n';
  const ctx = ctxWithFiles({ "./nano-generated/system-brief.json": payload });
  const res = await call(routeAt(ctx, "/app/agent.json"));
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /application\/json/);
  assert.equal(res.body, payload);
  assert.deepEqual(JSON.parse(res.body).processes, ["p"]);
});

test("brief artifacts resolve under ctx.root (rooted host keys), not the raw cwd-relative path", async () => {
  const ctx = ctxWithFiles({ "/srv/app/nano-generated/system-brief.md": "# rooted\n" });
  ctx.root = "/srv/app";
  const res = await call(routeAt(ctx, "/app/agent"));
  assert.equal(res.status, 200);
  assert.equal(res.body, "# rooted\n");
});

test("a missing brief (gen never ran) is a 404, not a crash", async () => {
  const ctx = ctxWithFiles({});
  const md = await call(routeAt(ctx, "/app/agent"));
  const jsonRes = await call(routeAt(ctx, "/app/agent.json"));
  assert.equal(md.status, 404);
  assert.equal(jsonRes.status, 404);
});

test("a non-ENOENT read error surfaces (500 via the host) instead of being masked as a 404", async () => {
  const ctx = ctxWithFiles({ "./nano-generated/system-brief.md": "unused" });
  ctx.host.readTextFile = async () => {
    throw new Error("EACCES: permission denied");
  };
  // exists() still reports the artifact present, so the handler must not swallow the read error
  // into a 404 — it lets it propagate, which the host server turns into a 500.
  await assert.rejects(call(routeAt(ctx, "/app/agent")), /EACCES/);
});
