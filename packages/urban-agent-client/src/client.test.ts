import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticClient, connectAgenticChannel } from "./client.ts";
import { encodeFrame } from "./protocol.ts";
import type { Frame, ServePayload } from "./protocol.ts";
import { fakeTransportFactory } from "./testkit.ts";

function serveFrame(instance: string, tokens: string[]): Uint8Array {
  const payload: ServePayload = { instance, tokens };
  const frame: Frame = { lane: "control", family: "serve", seq: 0, payload };
  return encodeFrame(frame);
}

function newClient(overrides: Partial<Parameters<typeof connectAgenticChannel>[0]> = {}) {
  const t = fakeTransportFactory();
  const client = new AgenticClient({
    url: "ws://test/agentic",
    instance: "worker-1",
    transport: t.factory,
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
    ...overrides,
  });
  return { client, t };
}

test("REGISTER → SERVE resolves the register promise with the resolved tokens", async () => {
  const { client, t } = newClient({ serveTimeoutMs: 1000 });
  client.connect();
  t.last().fireOpen();

  const pending = client.register({ capability: { cognition: "high", weight: 3, family: "opus", host: "cli" } });

  // The client sent a REGISTER frame carrying the capability (never a token).
  const sent = t.last().sentFrames;
  const register = sent.find((f) => f.family === "register");
  assert.ok(register, "a register frame was sent");
  assert.deepEqual(register?.payload, {
    instance: "worker-1",
    capability: { cognition: "high", weight: 3, family: "opus", host: "cli" },
  });

  // Hub answers with SERVE.
  t.last().deliver(serveFrame("worker-1", ["planning.spar#red", "implementation.impl"]));
  const { serve } = await pending;
  assert.deepEqual(serve, ["planning.spar#red", "implementation.impl"]);
  assert.deepEqual(client.serve, ["planning.spar#red", "implementation.impl"]);
  client.close();
});

test("a SERVE addressed to a different instance is ignored", async () => {
  const { client, t } = newClient({ serveTimeoutMs: 100 });
  client.connect();
  t.last().fireOpen();
  const pending = client.register({ capability: { cognition: "high" } });
  t.last().deliver(serveFrame("someone-else", ["planning.spar#red"]));
  await assert.rejects(pending, /SERVE not received/);
  client.close();
});

test("heartbeat, relay and deregister emit correctly-shaped frames", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();

  client.heartbeat();
  client.relay("stdout", "hello");
  client.relay("stdout", "world!");
  client.deregister("done");

  const frames = t.last().sentFrames;
  const heartbeat = frames.find((f) => f.family === "heartbeat");
  assert.deepEqual(heartbeat?.payload, { instance: "worker-1" });
  assert.equal(heartbeat?.lane, "control");

  const relays = frames.filter((f) => f.family === "relay");
  assert.equal(relays.length, 2);
  assert.equal(relays[0]?.lane, "bulk");
  // Per-stream byte offset advances by the UTF-8 length of each chunk.
  assert.deepEqual(relays[0]?.payload, { stream: "stdout", offset: 0, chunk: "hello" });
  assert.deepEqual(relays[1]?.payload, { stream: "stdout", offset: 5, chunk: "world!" });

  const dereg = frames.find((f) => f.family === "deregister");
  assert.deepEqual(dereg?.payload, { instance: "worker-1", reason: "done" });
  assert.ok(t.last().wasClosedLocally());
});

test("relay offset tracks UTF-8 byte length per stream, independently", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();
  client.relay("a", "é"); // 2 bytes UTF-8
  client.relay("b", "x"); // separate stream, offset 0
  client.relay("a", "z"); // offset now 2
  const relays = t.last().sentFrames.filter((f) => f.family === "relay");
  assert.deepEqual(relays.map((f) => f.payload), [
    { stream: "a", offset: 0, chunk: "é" },
    { stream: "b", offset: 0, chunk: "x" },
    { stream: "a", offset: 2, chunk: "z" },
  ]);
  client.close();
});

test("buffers while the hub is down and drains in QoS order on reconnect", () => {
  const { client, t } = newClient({ reconnect: { enabled: false }, capability: { cognition: "high" } });
  client.connect(); // transport built but not yet open

  // Produce a bulk storm plus a heartbeat while the channel is closed.
  for (let i = 0; i < 5; i++) {
    client.relay("stdout", `chunk-${i}`);
  }
  client.heartbeat();
  assert.equal(client.buffered, 6);
  assert.equal(t.last().sent.length, 0, "nothing sent while closed");

  // Channel comes up: everything drains.
  t.last().fireOpen();
  assert.equal(client.buffered, 0);

  const families = t.last().sentFrames.map((f) => f.family);
  // On open the client auto-re-registers (capability set); register + heartbeat
  // (control) drain ahead of the buffered bulk relay storm.
  assert.equal(families[0], "register");
  assert.equal(families[1], "heartbeat");
  assert.deepEqual(families.slice(2), ["relay", "relay", "relay", "relay", "relay"]);
});

test("survives a mid-stream drop: unsent frames stay buffered and drain on the next open", () => {
  const { client, t } = newClient({ reconnect: { enabled: false } });
  client.connect();
  t.last().fireOpen();
  client.relay("stdout", "a");
  assert.equal(client.buffered, 0);

  // Hub drops; produce more while down.
  t.last().drop();
  assert.equal(client.connected, false);
  client.relay("stdout", "b");
  client.relay("stdout", "c");
  assert.equal(client.buffered, 2);

  // Reconnect manually (auto-reconnect disabled in this test).
  client.connect();
  t.last().fireOpen();
  assert.equal(client.buffered, 0);
  const chunks = t.last().sentFrames.filter((f) => f.family === "relay").map((f) => f.payload);
  assert.deepEqual(chunks, [
    { stream: "stdout", offset: 1, chunk: "b" },
    { stream: "stdout", offset: 2, chunk: "c" },
  ]);
});

test("auto-reconnects with the injected scheduler and re-registers", () => {
  const scheduled: Array<() => void> = [];
  const { client, t } = newClient({
    reconnect: { enabled: true, initialDelayMs: 10 },
    capability: { cognition: "high" },
    schedule: (fn) => scheduled.push(fn),
  });
  client.connect();
  t.last().fireOpen();
  const firstTransport = t.last();

  firstTransport.drop();
  assert.equal(scheduled.length, 1, "a reconnect was scheduled");

  // Fire the scheduled reconnect: a new transport is built.
  scheduled[0]?.();
  assert.equal(t.transports.length, 2);
  t.last().fireOpen();

  // The reconnected channel re-announces presence.
  assert.equal(t.last().sentFrames[0]?.family, "register");
  client.close();
});

test("register while the hub is down buffers and resolves once it comes up", async () => {
  const { client, t } = newClient({ reconnect: { enabled: false }, serveTimeoutMs: 1000 });
  client.connect(); // not open

  const pending = client.register({ capability: { cognition: "high" } });
  assert.ok(client.buffered >= 1, "register frame is buffered while down");

  t.last().fireOpen(); // drains the buffered register
  t.last().deliver(serveFrame("worker-1", ["ci.gate"]));
  const { serve } = await pending;
  assert.deepEqual(serve, ["ci.gate"]);
  client.close();
});

test("malformed inbound bytes never crash the client — surfaced via onError", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();
  const errors: Error[] = [];
  client.onError((e) => errors.push(e));

  t.last().deliver(new Uint8Array([0x00, 0x01, 0x02])); // garbage, too short
  t.last().deliver(new Uint8Array()); // empty
  // The client is still alive and usable.
  client.heartbeat();
  assert.ok(errors.length >= 2);
  assert.ok(t.last().sentFrames.some((f) => f.family === "heartbeat"));
  client.close();
});

test("connectAgenticChannel returns an already-connecting client", () => {
  const t = fakeTransportFactory();
  const client = connectAgenticChannel({ url: "ws://test", transport: t.factory, reconnect: { enabled: false } });
  assert.equal(t.transports.length, 1);
  assert.equal(client.connectionState, "connecting");
  client.close();
});

test("close stops the client and rejects an in-flight register", async () => {
  const { client, t } = newClient({ serveTimeoutMs: 0 });
  client.connect();
  t.last().fireOpen();
  const pending = client.register({ capability: { cognition: "high" } });
  client.close();
  await assert.rejects(pending, /client closed/);
  assert.equal(client.connectionState, "closed");
});
