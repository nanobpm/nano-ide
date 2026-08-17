import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./events.ts";

test("emit — synchronous fire-and-forget notifies every listener in order", () => {
  const bus = new EventBus();
  const channel = bus.emit<string>("note");
  const seen: string[] = [];
  channel.on((m) => seen.push(`a:${m}`));
  channel.on((m) => seen.push(`b:${m}`));
  channel.emit("hi");
  assert.deepEqual(seen, ["a:hi", "b:hi"]);
});

test("emit — a throwing listener is contained; the rest still run", () => {
  const contained: string[] = [];
  const bus = new EventBus({ onError: (_e, info) => contained.push(info.event) });
  const channel = bus.emit<void>("boom");
  const seen: string[] = [];
  channel.on(() => {
    throw new Error("nope");
  });
  channel.on(() => seen.push("ran"));
  channel.emit();
  assert.deepEqual(seen, ["ran"]);
  assert.deepEqual(contained, ["boom"]);
});

test("emit — a rejecting async listener is contained, not an unhandled rejection", async () => {
  const contained: string[] = [];
  const bus = new EventBus({ onError: (_e, info) => contained.push(info.event) });
  const channel = bus.emit<void>("boom");
  const seen: string[] = [];
  channel.on(async () => {
    throw new Error("async nope");
  });
  channel.on(() => seen.push("ran"));
  channel.emit();
  assert.deepEqual(seen, ["ran"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(contained, ["boom"]);
});

test("emit — a rejecting thenable (non-native promise) listener is contained", async () => {
  const contained: string[] = [];
  const bus = new EventBus({ onError: (_e, info) => contained.push(info.event) });
  const channel = bus.emit<void>("boom");
  const seen: string[] = [];
  // A cross-realm / userland promise is a thenable but not `instanceof Promise`.
  channel.on(() => ({
    then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
      reject(new Error("thenable nope"));
    },
  }));
  channel.on(() => seen.push("ran"));
  channel.emit();
  assert.deepEqual(seen, ["ran"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(contained, ["boom"]);
});

test("emit — listeners are snapshotted; one registered mid-dispatch is not run this emission", () => {
  const bus = new EventBus();
  const channel = bus.emit<void>("note");
  const seen: string[] = [];
  channel.on(() => {
    seen.push("first");
    channel.on(() => seen.push("late")); // registered during dispatch
  });
  channel.on(() => seen.push("second"));
  channel.emit();
  assert.deepEqual(seen, ["first", "second"]); // "late" only runs on the next emit
  channel.emit();
  assert.deepEqual(seen, ["first", "second", "first", "second", "late"]);
});

test("serial — listeners are snapshotted; one registered mid-dispatch is not run this checkpoint", async () => {
  const bus = new EventBus();
  const channel = bus.serial<void>("checkpoint");
  const seen: string[] = [];
  channel.on(async () => {
    seen.push("first");
    channel.on(() => seen.push("late")); // registered during dispatch
  });
  channel.on(() => seen.push("second"));
  await channel.run();
  assert.deepEqual(seen, ["first", "second"]); // "late" only runs on the next run
});

test("serial — listeners run in registration order, each awaited", async () => {
  const bus = new EventBus();
  const channel = bus.serial<number>("checkpoint");
  const order: string[] = [];
  channel.on(async (n) => {
    await Promise.resolve();
    order.push(`first:${n}`);
  });
  channel.on(async (n) => {
    order.push(`second:${n}`);
  });
  await channel.run(7);
  assert.deepEqual(order, ["first:7", "second:7"]);
});

test("serial — a throwing checkpoint is contained; later checkpoints still run", async () => {
  const bus = new EventBus({ onError: () => {} });
  const channel = bus.serial<void>("cp");
  const order: string[] = [];
  channel.on(() => {
    order.push("one");
  });
  channel.on(async () => {
    throw new Error("boom");
  });
  channel.on(() => {
    order.push("three");
  });
  await channel.run();
  assert.deepEqual(order, ["one", "three"]);
});

test("parallel — every listener gets an independent chance even when one throws", async () => {
  const bus = new EventBus({ onError: () => {} });
  const channel = bus.parallel<void>("flush");
  const done: string[] = [];
  channel.on(async () => {
    await Promise.resolve();
    done.push("a");
  });
  channel.on(async () => {
    throw new Error("b failed");
  });
  channel.on(async () => {
    await Promise.resolve();
    done.push("c");
  });
  await channel.run();
  assert.deepEqual(done.sort(), ["a", "c"]);
});

test("waterfall — middlewares wrap next outermost-first and can transform the value", async () => {
  const bus = new EventBus();
  const channel = bus.waterfall<string, string>("transform");
  channel.on(async (value, next) => `<${await next(value)}>`);
  channel.on(async (value, next) => next(`${value}!`));
  const out = await channel.run("hi", (v) => v.toUpperCase());
  assert.equal(out, "<HI!>");
});

test("waterfall — a middleware short-circuits by not calling next", async () => {
  const bus = new EventBus();
  const channel = bus.waterfall<string, string>("gate");
  let baseRan = false;
  channel.on(() => "DENIED");
  channel.on(async (value, next) => next(value));
  const out = await channel.run("req", () => {
    baseRan = true;
    return "ALLOWED";
  });
  assert.equal(out, "DENIED");
  assert.equal(baseRan, false);
});

test("waterfall — a middleware recovers a downstream throw", async () => {
  const bus = new EventBus();
  const channel = bus.waterfall<string, string>("recover");
  channel.on(async (value, next) => {
    try {
      return await next(value);
    } catch {
      return "recovered";
    }
  });
  const out = await channel.run("x", () => {
    throw new Error("downstream boom");
  });
  assert.equal(out, "recovered");
});

test("waterfall — a throwing middleware that never called next is contained and delegated past", async () => {
  const contained: string[] = [];
  const bus = new EventBus({ onError: (_e, info) => contained.push(info.event) });
  const channel = bus.waterfall<string, string>("dispatch");
  channel.on(() => {
    throw new Error("plugin bug");
  });
  channel.on(async (value, next) => next(`${value}-seen`));
  const out = await channel.run("v", (v) => `base:${v}`);
  assert.equal(out, "base:v-seen");
  assert.deepEqual(contained, ["dispatch"]);
});

test("waterfall — next() is idempotent within a middleware: a second call re-advances nothing", async () => {
  const bus = new EventBus();
  const channel = bus.waterfall<string, string>("reentrant");
  let downstreamRuns = 0;
  // Inner middleware counts how often the chain advances past the outer one.
  channel.on(async (value, next) => {
    downstreamRuns += 1;
    return next(value);
  });
  let firstPromise: Promise<string> | undefined;
  let secondPromise: Promise<string> | undefined;
  channel.on((value, next) => {
    firstPromise = next(value);
    // A buggy or defensive middleware calling next() twice must not run the
    // downstream chain (or its side effects) a second time.
    secondPromise = next(value);
    return firstPromise;
  });
  const out = await channel.run("v", (v) => `base:${v}`);
  assert.equal(out, "base:v");
  assert.equal(downstreamRuns, 1);
  assert.strictEqual(firstPromise, secondPromise);
});

test("dispose ladder — a listener disposer detaches it and is idempotent", () => {
  const bus = new EventBus();
  const channel = bus.emit<void>("e");
  const off = channel.on(() => {});
  assert.equal(channel.size, 1);
  assert.equal(bus.listenerCount, 1);
  off();
  assert.equal(channel.size, 0);
  assert.equal(bus.listenerCount, 0);
  off(); // idempotent
  assert.equal(bus.listenerCount, 0);
});

test("dispose ladder — bus.dispose() unwinds every registration (start→stop→start leaks nothing)", () => {
  const bus = new EventBus();
  const emit = bus.emit<void>("a");
  const serial = bus.serial<void>("b");
  const waterfall = bus.waterfall<void, void>("c");

  const register = () => {
    emit.on(() => {});
    serial.on(() => {});
    waterfall.on((_v, next) => next());
  };

  register();
  assert.equal(bus.listenerCount, 3);
  bus.dispose(); // stop
  assert.equal(bus.listenerCount, 0);
  assert.equal(emit.size, 0);

  register(); // start again — no accumulation from the previous cycle
  assert.equal(bus.listenerCount, 3);
  bus.dispose();
  assert.equal(bus.listenerCount, 0);
});

test("dispose ladder — arbitrary effect() cleanups run on dispose, LIFO", () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.effect(() => order.push("first"));
  bus.effect(() => order.push("second"));
  bus.dispose();
  assert.deepEqual(order, ["second", "first"]);
});

test("dispose ladder — a throwing disposer is contained; the rest still unwind", () => {
  const contained: unknown[] = [];
  const bus = new EventBus({ onError: (e) => contained.push(e) });
  const order: string[] = [];
  bus.effect(() => order.push("a"));
  bus.effect(() => {
    throw new Error("bad disposer");
  });
  bus.effect(() => order.push("c"));
  bus.dispose();
  assert.deepEqual(order, ["c", "a"]);
  assert.equal(contained.length, 1);
});

test("effect() returns an idempotent disposer that also detaches from the ladder", () => {
  const bus = new EventBus();
  let cleaned = 0;
  const off = bus.effect(() => {
    cleaned += 1;
  });
  assert.equal(bus.listenerCount, 1);
  off();
  assert.equal(cleaned, 1);
  assert.equal(bus.listenerCount, 0);
  off(); // idempotent
  assert.equal(cleaned, 1);
  bus.dispose(); // already detached — not run again
  assert.equal(cleaned, 1);
});

test("a seam cannot be redeclared under a different mode", () => {
  const bus = new EventBus();
  bus.emit<void>("x");
  assert.throws(() => bus.serial<void>("x"), /already declared as "emit"/);
});

test("dispose ladder — an effect registered by a disposer during dispose is still unwound", () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.effect(() => {
    order.push("outer");
    // A disposer that registers another effect mid-teardown: the ladder must
    // keep unwinding until empty rather than dropping the late registration.
    bus.effect(() => order.push("late"));
  });
  bus.dispose();
  assert.deepEqual(order, ["outer", "late"]);
  assert.equal(bus.listenerCount, 0);
});

test("scope() — rolls back only registrations made after the scope opened, LIFO, and stays idempotent under dispose", () => {
  const bus = new EventBus();
  const order: string[] = [];
  const before = bus.effect(() => order.push("before"));
  const rollback = bus.scope();
  bus.effect(() => order.push("scoped-1"));
  bus.effect(() => order.push("scoped-2"));
  assert.equal(bus.listenerCount, 3);
  rollback();
  // Only the two effects added after the scope opened are unwound, newest-first.
  assert.deepEqual(order, ["scoped-2", "scoped-1"]);
  // The pre-scope registration is untouched.
  assert.equal(bus.listenerCount, 1);
  // A later dispose must not double-run the already-rolled-back effects.
  order.length = 0;
  void before;
  bus.dispose();
  assert.deepEqual(order, ["before"]);
  assert.equal(bus.listenerCount, 0);
});

test("scope() — keeps unwinding when a rolled-back disposer registers a new effect mid-rollback (truly atomic)", () => {
  const bus = new EventBus();
  const order: string[] = [];
  const before = bus.effect(() => order.push("before"));
  const rollback = bus.scope();
  bus.effect(() => order.push("scoped-1"));
  // A scoped disposer that registers ANOTHER effect while it is being rolled
  // back: that late registration is still "after" the scope point, so an atomic
  // rollback (like dispose()) must unwind it too rather than strand it live.
  bus.effect(() => {
    order.push("scoped-2");
    bus.effect(() => order.push("scoped-late"));
  });
  assert.equal(bus.listenerCount, 3);
  rollback();
  assert.deepEqual(order, ["scoped-2", "scoped-late", "scoped-1"]);
  // The pre-scope registration survives; nothing added after the scope leaks.
  assert.equal(bus.listenerCount, 1);
  void before;
  bus.dispose();
});

test("register — .on(sameListener) twice is idempotent: one ladder entry, shared disposer, no drift", () => {
  const bus = new EventBus();
  const channel = bus.emit<string>("e");
  const seen: string[] = [];
  const listener = (m: string) => seen.push(m);

  const off1 = channel.on(listener);
  const off2 = channel.on(listener);
  // A duplicate registration must not inflate the leak metric nor the channel.
  assert.equal(channel.size, 1);
  assert.equal(bus.listenerCount, 1);
  // The same disposer is handed back, so callers can't get out of sync.
  assert.equal(off1, off2);

  // The coalesced listener fires exactly once per emit.
  channel.emit("x");
  assert.deepEqual(seen, ["x"]);

  // Disposing once fully removes it — the ladder does not strand a phantom entry.
  off1();
  assert.equal(channel.size, 0);
  assert.equal(bus.listenerCount, 0);
  off2(); // idempotent second disposer call
  assert.equal(bus.listenerCount, 0);
});
