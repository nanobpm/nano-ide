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

test("a transport factory that throws surfaces onError and leaves 'connecting' instead of wedging", () => {
  const failure = new Error("no global WebSocket available");
  const errors: Error[] = [];
  const closes: number[] = [];
  const client = new AgenticClient({
    url: "ws://test/agentic",
    instance: "worker-1",
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
    transport: () => {
      throw failure;
    },
  });
  client.onError((e) => errors.push(e));
  client.onClose(() => closes.push(1));

  client.connect();

  // The synchronous factory failure must not escape connect(): it is surfaced as
  // a non-fatal error and drives a close, so the client leaves "connecting"
  // (reconnect disabled → idle) instead of wedging with no transport and no signal.
  assert.deepEqual(errors, [failure], "the factory failure surfaced via onError");
  assert.equal(closes.length, 1, "onClose fired once for the failed attempt");
  assert.equal(client.connectionState, "idle", "client did not wedge in 'connecting'");
});


test("deregister while the channel is down sends no deregister frame (best-effort only when open)", () => {
  const { client, t } = newClient();
  client.connect(); // transport built but never opened

  // Never fired open: the channel is down. A deregister must not enqueue an
  // unsendable frame that close() would only drop — it is best-effort.
  client.deregister("done");

  const dereg = t.last().sentFrames.find((f) => f.family === "deregister");
  assert.equal(dereg, undefined, "no deregister frame was sent while disconnected");
  assert.equal(client.connectionState, "closed");
  assert.equal(client.buffered, 0, "close() left nothing buffered");
});

test("close() releases the outbound buffer so a terminal client pins no backlog", () => {
  const { client } = newClient({ capability: { cognition: "high" } });
  client.connect(); // transport built but never opened

  // Accumulate a backlog during the outage: buffered relay frames.
  for (let i = 0; i < 4; i++) {
    client.relay("stdout", `chunk-${i}`);
  }
  assert.ok(client.buffered > 0, "frames buffered while the channel is down");

  client.close();

  // Terminal close must not pin the outage backlog in memory forever — the ring
  // (and the per-stream relay offsets) can never be drained again, so they are
  // released.
  assert.equal(client.buffered, 0, "close() cleared the outbound ring");
});

test("a closed client refuses every outbound-producing call instead of buffering frames that can never drain", async () => {
  const errors: Error[] = [];
  const { client } = newClient({ capability: { cognition: "high" } });
  client.onError((e) => errors.push(e));
  client.connect();
  client.close();

  // register() fails fast rather than creating a pending promise that never resolves.
  await assert.rejects(client.register({ capability: { cognition: "high" } }), /closed client/);

  // heartbeat/relay are refused (surfaced via onError) and buffer nothing.
  client.heartbeat();
  client.relay("stdout", "post-close");
  assert.equal(client.buffered, 0, "a closed client buffers no frames");
  assert.ok(
    errors.some((e) => /cannot heartbeat on a closed client/.test(e.message)),
    "heartbeat after close surfaces an error",
  );
  assert.ok(
    errors.some((e) => /cannot relay on a closed client/.test(e.message)),
    "relay after close surfaces an error",
  );
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

test("a superseding register coalesces the buffered REGISTER — only the newest capability drains", async () => {
  const { client, t } = newClient({ reconnect: { enabled: false }, serveTimeoutMs: 1000 });
  client.connect(); // not open — registers buffer

  const first = client.register({ capability: { cognition: "low" } });
  const second = client.register({ capability: { cognition: "high" } });

  // The stale REGISTER is dropped from the ring, not left to drain alongside the new one.
  assert.equal(client.buffered, 1, "only one REGISTER is buffered after superseding");
  await assert.rejects(first, /superseded/);

  t.last().fireOpen();
  const registers = t.last().sentFrames.filter((f) => f.family === "register");
  assert.equal(registers.length, 1, "exactly one REGISTER drains on open");
  assert.deepEqual(registers[0]?.payload, { instance: "worker-1", capability: { cognition: "high" } });

  t.last().deliver(serveFrame("worker-1", ["ci.gate"]));
  const { serve } = await second;
  assert.deepEqual(serve, ["ci.gate"]);
  client.close();
});

test("a throw-only transport (no onClose) still drives reconnect instead of wedging", () => {
  const scheduled: Array<() => void> = [];
  const { client, t } = newClient({
    reconnect: { enabled: true, initialDelayMs: 10 },
    schedule: (fn) => scheduled.push(fn),
  });
  client.connect();
  t.last().fireOpen();

  // The transport now fails every send WITHOUT firing onClose (contract-minimal).
  t.last().throwOnSend = true;
  const errors: Error[] = [];
  client.onError((e) => errors.push(e));

  client.relay("stdout", "boom"); // enqueue → pump → send throws

  // The client must not sit "open" with a full buffer waiting for an onClose
  // that never comes: it forces the disconnect and schedules a reconnect.
  assert.equal(client.connected, false, "client left the open state on send failure");
  assert.equal(scheduled.length, 1, "a reconnect was scheduled");
  assert.ok(errors.some((e) => /send fail/.test(e.message)), "the send failure was surfaced");
  assert.equal(client.buffered, 1, "the unsent frame stays buffered for the reconnect drain");

  // Reconnect and confirm the buffered frame drains on the fresh channel.
  scheduled[0]?.();
  assert.equal(t.transports.length, 2);
  t.last().fireOpen();
  assert.equal(client.buffered, 0, "buffered frame drained after reconnect");
  assert.ok(t.last().sentFrames.some((f) => f.family === "relay"));
  client.close();
});

test("an invalid outbound register payload rejects the promise fast without buffering", async () => {
  // An empty instance id fails the S0 register contract (bad-instance).
  const { client, t } = newClient({ instance: "", serveTimeoutMs: 0 });
  client.connect();
  t.last().fireOpen();

  await assert.rejects(
    client.register({ capability: { cognition: "high" } }),
    /register payload failed validation/,
  );
  // The unsendable frame was never buffered, and none was sent.
  assert.equal(client.buffered, 0);
  assert.equal(t.last().sentFrames.filter((f) => f.family === "register").length, 0);
  client.close();
});

test("an invalid outbound relay payload is dropped with onError, not buffered", () => {
  const { client, t } = newClient({ reconnect: { enabled: false } });
  client.connect(); // not open

  const errors: Error[] = [];
  client.onError((e) => errors.push(e));
  client.relay("", "data"); // empty stream fails the S0 relay contract

  assert.equal(client.buffered, 0, "the invalid relay was not buffered");
  assert.ok(errors.some((e) => /relay payload failed validation/.test(e.message)));
  client.close();
});

test("close notifies onClose subscribers even when the transport's close is silent/async", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();
  // Model a real WebSocket: close() does not synchronously surface onClose.
  t.last().silentClose = true;

  const closes: Array<{ local?: boolean }> = [];
  client.onClose((info) => closes.push(info));

  client.close();

  assert.equal(closes.length, 1, "onClose fired exactly once on caller-initiated close");
  assert.equal(closes[0]?.local, true, "the close is reported as local (caller-initiated)");
  assert.equal(client.connectionState, "closed");
});

test("close emits onClose exactly once even when the transport also fires its own onClose", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();
  // FakeTransport.close() DOES fire onClose synchronously; the client also drives
  // handleClose itself. The idempotency guard must collapse these to one emit.
  const closes: Array<{ local?: boolean }> = [];
  client.onClose((info) => closes.push(info));

  client.close();

  assert.equal(closes.length, 1, "exactly one close emitted despite two close signals");
  assert.equal(client.connectionState, "closed");
});

test("close notifies onClose even when the client never reached open (caller close while connecting)", () => {
  const { client } = newClient();
  client.connect(); // connecting — never fireOpen
  assert.equal(client.connectionState, "connecting");

  const closes: Array<{ local?: boolean }> = [];
  client.onClose((info) => closes.push(info));

  client.close();

  // A caller-initiated close while still connecting must surface onClose, just
  // like a remote drop while connecting already does — no silent shutdowns.
  assert.equal(closes.length, 1, "onClose fired once even though the channel never opened");
  assert.equal(closes[0]?.local, true, "reported as a local (caller-initiated) close");
  assert.equal(client.connectionState, "closed");
});

test("connect() is a no-op after close() — a shut-down client never reopens", () => {
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();
  client.close();
  assert.equal(client.connectionState, "closed");
  assert.equal(t.transports.length, 1);

  client.connect(); // must NOT reopen a terminally-closed client

  assert.equal(client.connectionState, "closed", "still closed after a post-close connect()");
  assert.equal(t.transports.length, 1, "no new transport was built after close()");
});

test("fakeTransportFactory().last() throws a clear error before any transport is created", () => {
  const t = fakeTransportFactory();
  // The type signature promises a FakeTransport; returning undefined here would be
  // a misleading runtime crash downstream, so last() must fail loudly and early.
  assert.throws(() => t.last(), /before any transport was created/);
});

test("on open, a REGISTER buffered behind other control frames is coalesced to the front", () => {
  const { client, t } = newClient({ reconnect: { enabled: false }, capability: { cognition: "high" } });
  client.connect(); // not open — control frames buffer

  client.heartbeat(); // control lane, buffered first
  // A register queued while down lands behind the heartbeat in the control lane.
  client.register({ capability: { cognition: "high" } }).catch(() => {});
  assert.equal(client.buffered, 2);

  t.last().fireOpen();

  const control = t.last().sentFrames.filter((f) => f.lane === "control").map((f) => f.family);
  assert.equal(control[0], "register", "REGISTER drains ahead of the buffered heartbeat");
  assert.equal(
    control.filter((f) => f === "register").length,
    1,
    "exactly one REGISTER drains (the buffered one was coalesced, not duplicated)",
  );
  client.close();
});
