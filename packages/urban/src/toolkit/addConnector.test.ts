import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenIO } from "./gen.ts";
import { addConnector } from "./addConnector.ts";

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
    async listDir() {
      return [];
    },
    async exists(p) {
      return p in files;
    },
    async remove(p) {
      delete files[p];
    },
  };
}

const PKG = "@nanobpm/nano-ide-connector-slack";
const PACK_ID = "nano-ide-connector-slack";

function baseFiles(appManifest: Record<string, unknown> = { schemaVersion: 1, id: "t", name: "T" }) {
  return {
    "app/nano.app.json": JSON.stringify(appManifest),
    [`app/node_modules/${PKG}/nano-ide.ext.json`]: JSON.stringify({
      id: PACK_ID,
      workers: [
        {
          type: "slack:send-message",
          entry: "worker.ts",
          configFields: [{ key: "botToken", env: "SLACK_BOT_TOKEN" }],
        },
      ],
    }),
  };
}

test("addConnector wires a pack-backed worker + a connection into nano.app.json", async () => {
  const io = memIO(baseFiles());
  const res = await addConnector({ root: "app", pkg: PKG, io });

  assert.equal(res.packId, PACK_ID);
  assert.deepEqual(res.wired, [{ taskType: "slack:send-message", alreadyPresent: false }]);
  assert.deepEqual(res.requiredEnv, ["SLACK_BOT_TOKEN"]);
  assert.equal(res.connection, "nano-ide-connector-slack");

  const app = JSON.parse(io.files["app/nano.app.json"]);
  assert.deepEqual(app.workers, [
    {
      taskType: "slack:send-message",
      connector: PACK_ID,
      connection: "nano-ide-connector-slack",
    },
  ]);
  assert.deepEqual(app.connections["nano-ide-connector-slack"], {
    type: PACK_ID,
    botToken: "${SLACK_BOT_TOKEN}",
  });
});

test("addConnector preserves the manifest's existing indentation (no lint reformat)", async () => {
  // Regression (nano-ide#454): the scaffold's Biome config formats nano.app.json with tabs, so a
  // hard-coded 2-space rewrite here would turn `npm run lint` red the moment a connector is
  // enabled in a fresh app. addConnector must round-trip the manifest's own indentation, like
  // `urban gen` does via detectJsonIndent.
  const tabManifest = `${JSON.stringify({ schemaVersion: 1, id: "t", name: "T" }, null, "\t")}\n`;
  const io = memIO({ ...baseFiles(), "app/nano.app.json": tabManifest });
  await addConnector({ root: "app", pkg: PKG, io });
  const written = io.files["app/nano.app.json"];
  assert.match(written, /\n\t"workers"/, "tab indentation is preserved");
  assert.doesNotMatch(written, /\n {2}"workers"/, "no 2-space indentation was introduced");

  const twoSpace = `${JSON.stringify({ schemaVersion: 1, id: "t", name: "T" }, null, 2)}\n`;
  const io2 = memIO({ ...baseFiles(), "app/nano.app.json": twoSpace });
  await addConnector({ root: "app", pkg: PKG, io: io2 });
  assert.match(io2.files["app/nano.app.json"], /\n {2}"workers"/, "2-space indentation is preserved");
});

test("addConnector is idempotent — re-running does not duplicate entries", async () => {
  const io = memIO(baseFiles());
  await addConnector({ root: "app", pkg: PKG, io });
  const res2 = await addConnector({ root: "app", pkg: PKG, io });
  assert.deepEqual(res2.wired, [{ taskType: "slack:send-message", alreadyPresent: true }]);
  const app = JSON.parse(io.files["app/nano.app.json"]);
  assert.equal(app.workers.length, 1);
  assert.equal(Object.keys(app.connections).length, 1);
});

test("addConnector throws on a taskType already backed by a handler (conflict)", async () => {
  const io = memIO(
    baseFiles({
      schemaVersion: 1,
      id: "t",
      name: "T",
      workers: [{ taskType: "slack:send-message", handler: "handlers/slack.ts" }],
    }),
  );
  await assert.rejects(() => addConnector({ root: "app", pkg: PKG, io }), /already declared with handler/);
});

test("addConnector throws when the package is not an Urban connector", async () => {
  const io = memIO({ "app/nano.app.json": JSON.stringify({ schemaVersion: 1, id: "t", name: "T" }) });
  await assert.rejects(() => addConnector({ root: "app", pkg: PKG, io }), /not an Urban connector/);
});

test("addConnector reports which app manifest fails to parse", async () => {
  const io = memIO({
    "app/nano.app.json": "{ not json",
    [`app/node_modules/${PKG}/nano-ide.ext.json`]: JSON.stringify({
      id: PACK_ID,
      workers: [{ type: "slack:send-message", entry: "worker.ts" }],
    }),
  });
  await assert.rejects(() => addConnector({ root: "app", pkg: PKG, io }), /failed to parse .*nano\.app\.json/);
});

test("addConnector rejects a manifest whose connections is not an object", async () => {
  const io = memIO(baseFiles({ schemaVersion: 1, id: "t", name: "T", connections: "nope" }));
  await assert.rejects(() => addConnector({ root: "app", pkg: PKG, io }), /"connections" must be an object/);
});

test("addConnector rejects an existing connection of a different type", async () => {
  const io = memIO(
    baseFiles({
      schemaVersion: 1,
      id: "t",
      name: "T",
      connections: { [PACK_ID]: { type: "other" } },
    }),
  );
  await assert.rejects(
    () => addConnector({ root: "app", pkg: PKG, io }),
    /already exists with type "other"/,
  );
});

test("addConnector rejects an existing connection that is not an object", async () => {
  const io = memIO(
    baseFiles({ schemaVersion: 1, id: "t", name: "T", connections: { [PACK_ID]: "nope" } }),
  );
  await assert.rejects(
    () => addConnector({ root: "app", pkg: PKG, io }),
    /already exists and is not an object/,
  );
});

test("addConnector backfills missing env pointers on a matching existing connection", async () => {
  const io = memIO(
    baseFiles({ schemaVersion: 1, id: "t", name: "T", connections: { [PACK_ID]: { type: PACK_ID } } }),
  );
  await addConnector({ root: "app", pkg: PKG, io });
  const app = JSON.parse(io.files["app/nano.app.json"]);
  assert.deepEqual(app.connections[PACK_ID], { type: PACK_ID, botToken: "${SLACK_BOT_TOKEN}" });
});

test("addConnector omits a connection when the pack needs no env credentials", async () => {
  const io = memIO({
    "app/nano.app.json": JSON.stringify({ schemaVersion: 1, id: "t", name: "T" }),
    [`app/node_modules/${PKG}/nano-ide.ext.json`]: JSON.stringify({
      id: PACK_ID,
      workers: [{ type: "noop:run", entry: "worker.ts" }],
    }),
  });
  const res = await addConnector({ root: "app", pkg: PKG, io });
  assert.equal(res.connection, undefined);
  assert.deepEqual(res.requiredEnv, []);
  const app = JSON.parse(io.files["app/nano.app.json"]);
  assert.deepEqual(app.workers, [{ taskType: "noop:run", connector: PACK_ID }]);
  assert.equal(app.connections, undefined);
});
