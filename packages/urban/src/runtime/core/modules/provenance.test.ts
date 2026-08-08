import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { makeGateway } from "./gateway.ts";
import {
  ensureProvenanceTable,
  makeProvenanceRecorder,
  WRITE_PROVENANCE_TABLE,
} from "./datasource.ts";
import {
  __resetExecStoreForTests,
  currentJobContext,
  installExecStore,
  runInJobContext,
  type JobExecContext,
} from "../execContext.ts";
import type { HostContext, SqliteDb } from "../host.ts";

interface Note {
  id: number;
  body: string;
}

interface ProvRow {
  source: string;
  table_name: string;
  pk_value: string;
  instance_key: string | null;
  element_id: string | null;
  job_type: string | null;
  op: string;
  at: string;
}

async function withSource(
  fn: (host: HostContext, db: SqliteDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-prov-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  try {
    await fn(host, db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function provRows(db: SqliteDb): ProvRow[] {
  return db.all<ProvRow>(`SELECT * FROM ${WRITE_PROVENANCE_TABLE} ORDER BY seq`);
}

test("insert inside a job context records a provenance row linking row → instance/element", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    ensureProvenanceTable(db);
    const src = makeGateway(db, makeProvenanceRecorder(host, db, "main"));
    const notes = src.table<Note>("notes");

    let id: number | bigint = 0;
    await runInJobContext(
      { instanceKey: "inst-1", elementId: "Task_persist", jobType: "notes.write" },
      async () => {
        id = await notes.insert({ body: "hello" });
      },
    );

    const rows = provRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "main");
    assert.equal(rows[0].table_name, "notes");
    assert.equal(rows[0].pk_value, String(id));
    assert.equal(rows[0].instance_key, "inst-1");
    assert.equal(rows[0].element_id, "Task_persist");
    assert.equal(rows[0].job_type, "notes.write");
    assert.equal(rows[0].op, "insert");
    assert.ok(rows[0].at.length > 0);
  });
});

test("insert outside any job context records no provenance (graceful degradation)", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    ensureProvenanceTable(db);
    const src = makeGateway(db, makeProvenanceRecorder(host, db, "main"));
    await src.table<Note>("notes").insert({ body: "no ctx" });
    assert.equal(provRows(db).length, 0);
  });
});

test("a job context without an instance key records no provenance", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    ensureProvenanceTable(db);
    const src = makeGateway(db, makeProvenanceRecorder(host, db, "main"));
    await runInJobContext({ jobType: "notes.write" }, async () => {
      await src.table<Note>("notes").insert({ body: "no instance" });
    });
    assert.equal(provRows(db).length, 0);
  });
});

test("a provenance-write failure never breaks the app insert", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    // Deliberately do NOT create the provenance table, so the recorder's own INSERT throws.
    const src = makeGateway(db, makeProvenanceRecorder(host, db, "main"));
    let id: number | bigint = 0;
    await runInJobContext({ instanceKey: "inst-9" }, async () => {
      id = await src.table<Note>("notes").insert({ body: "resilient" });
    });
    // The app row is written despite provenance capture failing.
    assert.equal((await src.table<Note>("notes").get(id))?.body, "resilient");
  });
});

test("the recorder does not record writes to urban/engine-internal tables", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    ensureProvenanceTable(db);
    const recorder = makeProvenanceRecorder(host, db, "main");
    runInJobContext({ instanceKey: "inst-1" }, () => {
      recorder("_urban_migrations", 1);
      recorder(WRITE_PROVENANCE_TABLE, 2);
      recorder("_nano_events", 3);
      recorder("sqlite_sequence", 4);
    });
    assert.equal(provRows(db).length, 0);
  });
});

test("with no store installed, capture is a transparent no-op", async () => {
  __resetExecStoreForTests();
  // No installExecStore call: runInJobContext must pass through and currentJobContext be undefined.
  let ran = false;
  const out = runInJobContext({ instanceKey: "x" }, () => {
    ran = true;
    assert.equal(currentJobContext(), undefined);
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(out, 42);
});

test("installExecStore is idempotent — the first install wins", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    void db;
    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    // A second install with a factory that would throw must be ignored (never invoked).
    installExecStore(() => {
      throw new Error("second install must not run");
    });
    runInJobContext({ instanceKey: "inst-2" }, () => {
      assert.equal(currentJobContext()?.instanceKey, "inst-2");
    });
  });
});

test("installExecStore can install after an incapable host returns no store", async () => {
  __resetExecStoreForTests();
  await withSource(async (host, db) => {
    void db;
    installExecStore(() => undefined);
    assert.equal(currentJobContext(), undefined);

    installExecStore(() => host.createAsyncStore?.<JobExecContext>());
    runInJobContext({ instanceKey: "inst-3" }, () => {
      assert.equal(currentJobContext()?.instanceKey, "inst-3");
    });
  });
});
