// Security regression tests for the hosted surfaces: manifest-provided values
// (surface paths, chat agent) must not be able to inject markup/script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSurfaces } from "./surfaces.ts";
import type { EngineClient, HostContext, HttpRequest, HttpResponse } from "../host.ts";
import { DataLayer } from "./datasource.ts";
import { createLogger } from "../logger.ts";

function ctxWith(surfaces: Record<string, unknown>): Parameters<typeof mountSurfaces>[0] {
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
  const engine: EngineClient = {
    deployResources: async () => ({ deployed: 0 }),
    createInstance: async () => ({ processInstanceKey: "pi" }),
    cancelInstance: async () => {},
    publishMessage: async () => {},
    searchUserTasks: async () => [],
    completeUserTask: async () => {},
    searchProcessInstances: async () => [],
    registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
    close: async () => {},
  };
  return { root: ".", manifest: { schemaVersion: 1, id: "app", name: "App", surfaces }, host, engine };
}

const fakeEngine: EngineClient = {
  deployResources: async () => ({ deployed: 0 }),
  createInstance: async () => ({ processInstanceKey: "pi" }),
  cancelInstance: async () => {},
  publishMessage: async () => {},
  searchUserTasks: async () => [],
  completeUserTask: async () => {},
  searchProcessInstances: async () => [],
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

const fakeApp: Parameters<typeof mountSurfaces>[1] = {
  manifest: { schemaVersion: 1, id: "app", name: "App" },
  data: new DataLayer(new Map(), undefined, {}),
  engine: fakeEngine,
  env: () => undefined,
  log: createLogger(() => {}),
};

async function render(route: { handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> }): Promise<string> {
  const res = await route.handler({
    method: "GET",
    path: "/",
    query: new URLSearchParams(),
    headers: new Headers(),
    text: async () => "",
  });
  return String(res.body);
}

test("chat agent is HTML-escaped in the mount page", async () => {
  const s = mountSurfaces(ctxWith({ chat: { enabled: true, agent: "<img src=x onerror=alert(1)>" } }), fakeApp);
  const chatRoute = s.routes.find((r) => r.source === "surface:chat" && r.method === "GET")!;
  const body = await render(chatRoute);
  assert.ok(!body.includes("<img src=x"), "raw markup must not appear");
  assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;"), "agent is escaped");
});

test("task-inbox path is injected as a quoted JS literal (no script breakout)", async () => {
  const evil = "/tasks'});alert(1);//x";
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: evil } }), fakeApp);
  const page = s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && !r.path.endsWith("/api/tasks"))!;
  const body = await render(page);
  // The path is embedded via JSON.stringify, so the raw breakout sequence must
  // not appear unescaped inside the <script>.
  assert.ok(!body.includes("'});alert(1);//'"), "no raw single-quoted breakout");
  assert.ok(body.includes(JSON.stringify(evil)), "path embedded as a JSON string literal");
});
