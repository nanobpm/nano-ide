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
