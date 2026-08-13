import { test } from "node:test";
import assert from "node:assert/strict";
import { runDev, shouldReload, type DevDeps } from "./devserver.ts";
import type { HostContext } from "./core/host.ts";
import type { UrbanApp } from "./core/runtime.ts";
import { createLogger } from "./core/logger.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("shouldReload triggers on source files and the manifest", () => {
  for (const p of [
    "nano.app.json",
    "processes/greet.bpmn",
    "decisions/route.dmn",
    "forms/greet.form",
    "workers/greet.ts",
    "workers/greet.js",
    "db/migrations/001_init.sql",
    "./processes/greet.bpmn",
  ]) {
    assert.equal(shouldReload(p), true, `expected reload for ${p}`);
  }
});

test("shouldReload ignores generated output, deps, VCS and db churn", () => {
  for (const p of [
    "nano-generated/greeting.schema.sql",
    "nano-generated/urban-workers.d.ts",
    "node_modules/left-pad/index.js",
    ".git/index",
    "dist/index.js",
    "db/app.db",
    "db/app.db-wal",
    "db/app.db-shm",
    "db/app.sqlite-journal",
    "README.md",
    "notes.txt",
    "",
  ]) {
    assert.equal(shouldReload(p), false, `expected no reload for ${p}`);
  }
});

test("shouldReload honours a custom manifest filename", () => {
  assert.equal(shouldReload("config/app.json", "config/app.json"), true, "custom manifest reloads");
  assert.equal(shouldReload("app.config.json", "app.config.json"), true, "by basename too");
  // A .json that is NOT the configured manifest is not a source file.
  assert.equal(shouldReload("tsconfig.json"), false, "unrelated json ignored");
  assert.equal(shouldReload("config/app.json"), false, "custom manifest ignored under default");
});

test("stop() cancels a pending debounced reload", async () => {
  const starts: string[] = [];
  const stops: string[] = [];
  let clock = 1;
  let watch!: ReturnType<typeof fakeHost>;
  const deps: DevDeps = {
    makeHost: () => ((watch = fakeHost()), watch.host),
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => clock++,
  };
  const dev = await runDev({ debounceMs: 50, log: () => {} }, deps);
  watch.fire("workers/x.ts"); // schedules a reload 50ms out
  await dev.stop(); // stop before the debounce fires
  await delay(80);
  assert.equal(starts.length, 1, "pending reload was cancelled by stop()");
  assert.equal(watch.closed(), true, "watcher closed");
  assert.deepEqual(stops, ["a0"], "the running app was stopped exactly once");
});

test("stop() during an in-flight reload does not start a replacement app", async () => {
  const starts: string[] = [];
  const stops: string[] = [];
  let clock = 1;
  const hosts: ReturnType<typeof fakeHost>[] = [];
  // Gate the boot app's stop() so we can flip shutdown mid-reload, in the window
  // between the old app being stopped and the new one starting.
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((r) => (releaseStop = r));

  const deps: DevDeps = {
    makeHost: () => {
      const h = fakeHost();
      hosts.push(h);
      return h.host;
    },
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      if (id === "a0") {
        const app: UrbanApp = {
          ...fakeApp(stops, id),
          async stop() {
            await stopGate; // block the first reload inside app.stop()
            stops.push(id);
          },
        };
        return app;
      }
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 5, log: () => {} }, deps);
  hosts[0].fire("workers/x.ts"); // triggers a reload; it will block inside app.stop()
  await delay(20);
  const stopping = dev.stop(); // flips `stopped` while the reload is parked in app.stop()
  releaseStop(); // let the old app finish stopping; reload must now bail, not start a0's replacement
  await stopping;

  assert.deepEqual(starts, ["a0"], "no replacement app started during teardown");
  assert.deepEqual(stops, ["a0"], "the running app was stopped exactly once");
  assert.equal(hosts[0].closed(), true, "watcher closed");
});

test("import nonce is unique per reload even within the same millisecond", async () => {
  const starts: string[] = [];
  const stops: string[] = [];
  const nonces: string[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const deps: DevDeps = {
    makeHost: (nonce) => {
      nonces.push(nonce);
      const h = fakeHost();
      hosts.push(h);
      return h.host;
    },
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => 42, // frozen clock: nonce uniqueness must come from the reload counter
  };
  const dev = await runDev({ debounceMs: 1, log: () => {} }, deps);
  // The watcher is registered on the boot host only; fire both changes through it.
  hosts[0].fire("workers/a.ts");
  await delay(15);
  hosts[0].fire("workers/b.ts");
  await delay(15);
  await dev.stop();
  assert.equal(nonces.length, 3, "boot + two reloads built three hosts");
  assert.equal(new Set(nonces).size, 3, "every import nonce is distinct");
});

test("a change during an in-flight reload doesn't detach stop() from it", async () => {
  // Regression: schedule() used to overwrite `inFlight` with reload()'s already-resolved
  // no-op promise when a reload was already running, so stop() wouldn't await the real
  // reload and could tear down while it started a replacement app (a leak).
  const starts: string[] = [];
  const stops: string[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  let clock = 1;
  // Gate a1's start so reload #1 parks *past* the shutdown checks, inside startApp.
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => (releaseStart = r));

  const deps: DevDeps = {
    makeHost: () => {
      const h = fakeHost();
      hosts.push(h);
      return h.host;
    },
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      if (id === "a1") await startGate; // park reload #1 inside startApp
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 5, log: () => {} }, deps);
  hosts[0].fire("workers/a.ts"); // reload #1: stops a0, then parks starting a1
  await delay(20);
  hosts[0].fire("workers/b.ts"); // a second change lands while reload #1 is in flight
  await delay(20);

  const stopping = dev.stop(); // must await the real reload #1, not a stale resolved promise
  releaseStart(); // let reload #1 finish starting a1
  await stopping;

  assert.deepEqual(starts, ["a0", "a1"], "reload #1 started its replacement app");
  assert.deepEqual(stops, ["a0", "a1"], "stop() awaited reload #1 and stopped a1 (no leak)");
});

// A minimal fake host: runDev only calls host.watch on it.
function fakeHost(): { host: HostContext; fire: (p: string) => void; closed: () => boolean } {
  let cb: ((p: string) => void) | undefined;
  let closed = false;
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
    watch(onChange: (p: string) => void) {
      cb = onChange;
      return { close: () => (closed = true) };
    },
    now: () => 0,
    log: () => {},
  };
  return { host, fire: (p) => cb?.(p), closed: () => closed };
}

function fakeApp(stops: string[], id: string): UrbanApp {
  return {
    manifest: { schemaVersion: 1, id, name: id },
    root: ".",
    async start() {},
    async stop() {
      stops.push(id);
    },
    inspect: () => ({ app: id }),
    log: createLogger(() => {}),
    data: undefined,
    security: undefined,
    httpPort: undefined,
    httpServer: undefined,
  };
}

test("runDev derives + starts once, then hot-reloads on a relevant change", async () => {
  const gens: string[] = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const nonces: string[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  let clock = 1000;

  const deps: DevDeps = {
    makeHost: (nonce) => {
      nonces.push(nonce);
      const h = fakeHost();
      hosts.push(h);
      return h.host;
    },
    startApp: async (_host) => {
      const id = `app#${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async (root, mf) => {
      gens.push(`${root}:${mf}`);
      return { count: 2 };
    },
    now: () => clock++,
  };

  const logs: string[] = [];
  const dev = await runDev(
    { root: ".", manifestPath: "nano.app.json", debounceMs: 5, log: (m) => logs.push(m) },
    deps,
  );

  assert.deepEqual(gens, [".:nano.app.json"], "gen ran once at boot");
  assert.deepEqual(starts, ["app#0"], "app started once at boot");
  assert.equal(stops.length, 0, "nothing stopped yet");

  // runDev registers the watcher on the boot host only; fire through it.
  const bootWatch = hosts[0];

  // An irrelevant change (the sqlite db) must NOT reload.
  bootWatch.fire("db/app.db");
  await delay(20);
  assert.equal(starts.length, 1, "db churn did not reload");

  // A relevant change reloads: stop old, regen, start new with a fresh nonce.
  bootWatch.fire("processes/greet.bpmn");
  await delay(20);
  assert.deepEqual(stops, ["app#0"], "old app stopped");
  assert.equal(gens.length, 2, "gen reran on reload");
  assert.deepEqual(starts, ["app#0", "app#1"], "new app started");
  assert.notEqual(nonces[0], nonces[1], "import nonce changed across reload");

  await dev.stop();
  assert.equal(bootWatch.closed(), true, "watcher closed on stop");
  assert.deepEqual(stops, ["app#0", "app#1"], "current app stopped on shutdown");
});

test("runDev coalesces a burst of changes into a single reload (debounce)", async () => {
  const starts: string[] = [];
  const stops: string[] = [];
  let clock = 1;
  let watch!: ReturnType<typeof fakeHost>;

  const deps: DevDeps = {
    makeHost: () => ((watch = fakeHost()), watch.host),
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 15, log: () => {} }, deps);
  for (const p of ["workers/a.ts", "workers/b.ts", "forms/c.form"]) watch.fire(p);
  await delay(40);
  assert.equal(starts.length, 2, "three rapid edits produced exactly one reload");
  await dev.stop();
});

test("runDev survives a failing reload and keeps the previous app running", async () => {
  const stops: string[] = [];
  let boom = false;
  let clock = 1;
  let watch!: ReturnType<typeof fakeHost>;
  const logs: string[] = [];

  const deps: DevDeps = {
    makeHost: () => ((watch = fakeHost()), watch.host),
    startApp: async () => fakeApp(stops, "app"),
    regenerate: async () => {
      if (boom) throw new Error("bad manifest");
      return { count: 1 };
    },
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 5, log: (m) => logs.push(m) }, deps);
  boom = true;
  watch.fire("nano.app.json");
  await delay(20);
  assert.ok(
    logs.some((l) => l.includes("reload failed")),
    "a failed reload is reported, not thrown",
  );
  await dev.stop();
});
