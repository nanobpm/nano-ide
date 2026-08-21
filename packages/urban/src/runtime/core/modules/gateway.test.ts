import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { makeGateway, Table, type DataSource } from "./gateway.ts";

interface Order {
  id: number;
  status: string;
  total: number;
}

async function withGateway(fn: (src: DataSource) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-gateway-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  db.exec(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0)",
  );
  try {
    await fn(makeGateway(db));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("Table insert/get returns the row by primary key", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    const id = await orders.insert({ status: "new", total: 10 });
    const row = await orders.get(id);
    assert.equal(row?.status, "new");
    assert.equal(row?.total, 10);
    assert.equal(Number(row?.id), Number(id));
  });
});

test("Table update patches and returns rows changed", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    const id = await orders.insert({ status: "new", total: 10 });
    const changed = await orders.update(id, { status: "shipped" });
    assert.equal(changed, 1);
    assert.equal((await orders.get(id))?.status, "shipped");
  });
});

test("Table find/findOne filter by equality", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await orders.insert({ status: "new", total: 1 });
    await orders.insert({ status: "new", total: 2 });
    await orders.insert({ status: "done", total: 3 });
    const news = await orders.find({ status: "new" });
    assert.equal(news.length, 2);
    const one = await orders.findOne({ status: "done" });
    assert.equal(one?.total, 3);
    assert.equal(await orders.findOne({ status: "missing" }), undefined);
  });
});

test("Table count respects the filter", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await orders.insert({ status: "new", total: 1 });
    await orders.insert({ status: "done", total: 2 });
    assert.equal(await orders.count(), 2);
    assert.equal(await orders.count({ status: "new" }), 1);
  });
});

test("Table all lists rows and honours limit", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await orders.insert({ status: "a", total: 1 });
    await orders.insert({ status: "b", total: 2 });
    assert.equal((await orders.all()).length, 2);
    assert.equal((await orders.all(1)).length, 1);
  });
});

test("Table delete removes the row", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    const id = await orders.insert({ status: "new", total: 1 });
    assert.equal(await orders.delete(id), 1);
    assert.equal(await orders.get(id), undefined);
  });
});

test("tx commits on success and rolls back on throw", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await src.tx(async (t) => {
      await t.exec("INSERT INTO orders (status, total) VALUES (?, ?)", ["tx", 5]);
    });
    assert.equal(await orders.count({ status: "tx" }), 1);

    await assert.rejects(
      src.tx(async (t) => {
        await t.exec("INSERT INTO orders (status, total) VALUES (?, ?)", ["bad", 9]);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await orders.count({ status: "bad" }), 0);
  });
});

test("schema introspects columns/pk and excludes internal tables", async () => {
  await withGateway(async (src) => {
    await src.exec("CREATE TABLE _urban_migrations (id TEXT PRIMARY KEY)");
    await src.exec("CREATE TABLE _nano_ledger (id TEXT PRIMARY KEY)");
    const meta = await src.schema();
    const names = meta.map((t) => t.name);
    assert.deepEqual(names, ["orders"]);
    const orders = meta[0];
    const idCol = orders.columns.find((c) => c.name === "id");
    assert.equal(idCol?.primaryKey, true);
    const statusCol = orders.columns.find((c) => c.name === "status");
    assert.equal(statusCol?.notNull, true);
  });
});

test("schema introspects a VIEW tagged read-only; base tables stay writable", async () => {
  await withGateway(async (src) => {
    await src.exec(
      "INSERT INTO orders (id, status, total) VALUES (1, 'new', 10), (2, 'paid', 20)",
    );
    // A derived rollup as a SQL VIEW — the exact "no drift surface" the issue enables.
    await src.exec(
      "CREATE VIEW paid_orders AS SELECT id, total FROM orders WHERE status = 'paid'",
    );

    const meta = await src.schema();
    const byName = new Map(meta.map((t) => [t.name, t]));

    // Both the base table and the view are introspected…
    assert.deepEqual(
      meta.map((t) => t.name),
      ["orders", "paid_orders"],
    );
    // …and tagged so a write surface can tell them apart.
    assert.equal(byName.get("orders")?.kind, "table");
    assert.equal(byName.get("paid_orders")?.kind, "view");

    // A view has columns (pk/notnull report 0 — a view has no primary key).
    const view = byName.get("paid_orders");
    assert.deepEqual(
      view?.columns.map((c) => c.name),
      ["id", "total"],
    );
    assert.equal(view?.columns.every((c) => c.primaryKey === false), true);
  });
});

test("datasource reads rows from a VIEW with filter and order applied", async () => {
  interface Paid {
    id: number;
    total: number;
  }
  await withGateway(async (src) => {
    await src.exec(
      "INSERT INTO orders (id, status, total) VALUES " +
        "(1, 'new', 10), (2, 'paid', 20), (3, 'paid', 5)",
    );
    await src.exec(
      "CREATE VIEW paid_orders AS SELECT id, total FROM orders WHERE status = 'paid'",
    );

    const view = src.table<Paid>("paid_orders");
    // The Table read path (`SELECT * FROM <name> …`) works verbatim on a view.
    const all = await view.all();
    assert.deepEqual(
      all.map((r) => r.id).sort(),
      [2, 3],
    );
    // filter (WHERE) applies as normal.
    const byTotal = await view.find({ total: 20 });
    assert.deepEqual(byTotal.map((r) => r.id), [2]);
    // ordered raw read (ORDER BY) applies as normal.
    const ordered = await src.query<Paid>(
      "SELECT * FROM paid_orders ORDER BY total ASC",
    );
    assert.deepEqual(ordered.map((r) => r.id), [3, 2]);
  });
});

test("a base table is writable but a VIEW is not", async () => {
  await withGateway(async (src) => {
    await src.exec("INSERT INTO orders (id, status, total) VALUES (1, 'paid', 20)");
    await src.exec(
      "CREATE VIEW paid_orders AS SELECT id, total FROM orders WHERE status = 'paid'",
    );

    // The base table writes fine.
    const orders = src.table<Order>("orders");
    const id = await orders.insert({ status: "new", total: 3 });
    assert.equal(typeof id === "number" || typeof id === "bigint", true);

    // SQLite rejects a write to a view — the write surface must never offer it.
    const view = src.table<{ id: number; total: number }>("paid_orders");
    await assert.rejects(() => view.insert({ id: 99, total: 1 }));
  });
});

test("schema excludes internal tables AND internal views", async () => {
  await withGateway(async (src) => {
    await src.exec("CREATE VIEW _urban_hidden AS SELECT 1 AS x");
    await src.exec("CREATE VIEW _nano_hidden AS SELECT 1 AS x");
    await src.exec("CREATE VIEW visible AS SELECT id FROM orders");
    const names = (await src.schema()).map((t) => t.name);
    assert.deepEqual(names, ["orders", "visible"]);
  });
});

test("query rejects (not throws synchronously) on invalid SQL", async () => {
  await withGateway(async (src) => {
    await assert.rejects(src.query("SELECT * FROM does_not_exist"));
    await assert.rejects(src.exec("INSERT INTO does_not_exist (x) VALUES (1)"));
  });
});

test("Table.insert throws when the driver reports no lastInsertId", async () => {
  const fake: DataSource = {
    query: async () => [],
    exec: async () => ({ changed: 1 }),
    tx: async (fn) => fn(fake),
    schema: async () => [],
    table: (name, pk) => new Table(fake, name, pk),
  };
  const t = fake.table("orders");
  await assert.rejects(t.insert({ status: "x" }), /no lastInsertId/);
});

test("Table.all ignores a non-finite limit", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await orders.insert({ status: "a", total: 1 });
    await orders.insert({ status: "b", total: 2 });
    assert.equal((await orders.all(Number.NaN)).length, 2);
    assert.equal((await orders.all(Number.POSITIVE_INFINITY)).length, 2);
  });
});

test("query/exec run raw parameterised SQL", async () => {
  await withGateway(async (src) => {
    const r = await src.exec("INSERT INTO orders (status, total) VALUES (?, ?)", ["raw", 42]);
    assert.equal(r.changed, 1);
    const rows = await src.query<{ total: number }>("SELECT total FROM orders WHERE status = ?", ["raw"]);
    assert.equal(Number(rows[0]?.total), 42);
  });
});

test("insert omits undefined-valued keys so the column DEFAULT applies", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    // `total` is `NOT NULL DEFAULT 0`; passing it as undefined must omit the column
    // (not bind NULL, which would violate NOT NULL), letting the DEFAULT fill it.
    const id = await orders.insert({ status: "new", total: undefined });
    assert.equal((await orders.get(id))?.total, 0);
  });
});

test("insert preserves an explicit null; omits undefined", async () => {
  await withGateway(async (src) => {
    await src.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, tag TEXT DEFAULT 'none')");
    const notes = src.table("notes");
    const id = await notes.insert({ body: null, tag: undefined });
    const row = await notes.get(id);
    assert.equal(row?.body, null); // explicit null is stored as NULL
    assert.equal(row?.tag, "none"); // undefined omitted → column DEFAULT
  });
});

test("update skips undefined keys and clears on explicit null", async () => {
  await withGateway(async (src) => {
    await src.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, tag TEXT DEFAULT 'none')");
    const notes = src.table("notes");
    const id = await notes.insert({ body: "hello", tag: "x" });
    // tag:undefined must be left unchanged; body updated.
    await notes.update(id, { tag: undefined, body: "world" });
    let row = await notes.get(id);
    assert.equal(row?.body, "world");
    assert.equal(row?.tag, "x");
    // explicit null clears the column.
    await notes.update(id, { body: null });
    row = await notes.get(id);
    assert.equal(row?.body, null);
    // a patch of only-undefined keys is a no-op.
    assert.equal(await notes.update(id, { tag: undefined }), 0);
  });
});

test("insert throws when every provided value is undefined", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    await assert.rejects(
      orders.insert({ status: undefined, total: undefined }),
      /all values were undefined/,
    );
  });
});

test("insert throws a distinct message for a genuinely empty row", async () => {
  await withGateway(async (src) => {
    const orders = src.table<Order>("orders");
    const empty: Partial<Order> = {};
    await assert.rejects(orders.insert(empty), /empty row/);
  });
});
