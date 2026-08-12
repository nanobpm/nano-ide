import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AgenticClient, connectAgenticChannel } from "./client.ts";
import { encodeFrame } from "./protocol.ts";
import type { Frame, ServePayload } from "./protocol.ts";
import { fakeTransportFactory } from "./testkit.ts";
import type { TransportCloseInfo, TransportFactory, TransportHooks } from "./transport.ts";

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

test("a rejected relay consumes no offset space (advance-only-on-accept)", () => {
  const { client, t } = newClient({ reconnect: { enabled: false } });
  client.connect();
  t.last().fireOpen();

  const errors: Error[] = [];
  client.onError((e) => errors.push(e));

  // An empty stream fails the S0 relay contract, so the frame is rejected at
  // enqueue time. The offset for a real stream must be untouched by it, and a
  // rejected relay must never advance its own (empty-stream) offset bucket.
  client.relay("stdout", "ok"); // accepted → stdout offset advances to 2
  client.relay("", "dropped"); // rejected: empty stream
  client.relay("stdout", "next"); // must resume at offset 2, unaffected by the reject

  assert.ok(errors.some((e) => /relay payload failed validation/.test(e.message)));
  const relays = t.last().sentFrames.filter((f) => f.family === "relay").map((f) => f.payload);
  assert.deepEqual(
    relays,
    [
      { stream: "stdout", offset: 0, chunk: "ok" },
      { stream: "stdout", offset: 2, chunk: "next" },
    ],
    "the rejected relay neither advanced nor corrupted any offset",
  );
  client.close();
});

test("capability set in options starts the auto-heartbeat timer on open, without an explicit register()", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { client, t } = newClient({
      capability: { cognition: "high" },
      heartbeatIntervalMs: 1000,
    });
    client.connect();
    // Open auto-registers (capability was set in options); the documented
    // auto-heartbeat must start here too, even though register() is never called.
    t.last().fireOpen();

    mock.timers.tick(1000);

    const families = t.last().sentFrames.map((f) => f.family);
    assert.ok(
      families.includes("heartbeat"),
      "auto-heartbeat fired for an auto-registered client without an explicit register()",
    );
    client.close();
  } finally {
    mock.timers.reset();
  }
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

test("a send failure reports a remote (non-local) close even when transport.close() fires its own onClose", () => {
  const { client, t } = newClient({ reconnect: { enabled: false } });
  const closes: TransportCloseInfo[] = [];
  client.onClose((info) => closes.push(info));
  client.connect();
  t.last().fireOpen();

  // Arm a send failure. When forceReconnect tears the transport down, the
  // FakeTransport's close() synchronously fires its own onClose({ local: true }).
  // The client must still report this send failure as a REMOTE drop, not a
  // caller-initiated (local) close, so onClose subscribers aren't misled.
  t.last().throwOnSend = true;
  client.relay("stdout", "boom"); // pump → send throws → forceReconnect({ local: false })

  assert.equal(closes.length, 1, "exactly one close is reported");
  assert.equal(closes[0]?.local, false, "a send failure is a remote drop, not a local close");
  client.close();
});

test("auto-heartbeats coalesce while down so a long outage can't shed buffered relay", () => {
  // A bounded ring: control-lane heartbeats are never evicted, so without
  // coalescing an outage's worth of heartbeat ticks would pile up and shed the
  // buffered bulk relay (worker output) via the QoS overflow policy.
  const { client, t } = newClient({
    reconnect: { enabled: false },
    capability: { cognition: "high" },
    bufferCapacity: 3,
  });
  client.connect(); // connecting, not yet open

  client.relay("stdout", "work"); // one bulk relay buffered
  for (let i = 0; i < 10; i++) {
    client.heartbeat(); // a long outage's worth of heartbeat ticks
  }
  assert.equal(client.buffered, 2, "at most one heartbeat is buffered regardless of tick count");

  t.last().fireOpen();
  const families = t.last().sentFrames.map((f) => f.family);
  assert.deepEqual(
    families,
    ["register", "heartbeat", "relay"],
    "the buffered relay survived and drains after the heartbeats coalesced",
  );
  client.close();
});

test("the default reconnect scheduler unrefs its backoff timer so it can't pin the event loop open", () => {
  // Spy on the shared Timeout prototype's unref so we observe the DEFAULT
  // scheduler (no `schedule` override) unref its backoff timer, just like the
  // serve-timeout and heartbeat timers do.
  const probe = setTimeout(() => {}, 0);
  const timeoutProto = Object.getPrototypeOf(probe);
  clearTimeout(probe);
  const unrefSpy = mock.method(timeoutProto, "unref");
  try {
    const t = fakeTransportFactory();
    const client = new AgenticClient({
      url: "ws://test/agentic",
      instance: "worker-1",
      transport: t.factory,
      reconnect: { enabled: true, initialDelayMs: 10 },
    });
    client.connect();
    t.last().fireOpen();

    unrefSpy.mock.resetCalls();
    t.last().drop(); // remote drop → default scheduler schedules a reconnect
    assert.ok(unrefSpy.mock.callCount() >= 1, "the default reconnect backoff timer was unref'd");
    client.close();
  } finally {
    unrefSpy.mock.restore();
  }
});

test("close() releases the outbound buffer BEFORE it emits onClose, so subscribers see a self-consistent terminal state", () => {
  const { client } = newClient({ capability: { cognition: "high" } });
  client.connect(); // transport built but never opened

  // Accumulate an outage backlog: buffered relay frames + per-stream offsets.
  for (let i = 0; i < 4; i++) {
    client.relay("stdout", `chunk-${i}`);
  }
  assert.ok(client.buffered > 0, "frames buffered while the channel is down");

  // An onClose subscriber must observe the released buffers close() documents,
  // not a stale non-zero backlog. Capture what `buffered` reads at emit time.
  let bufferedAtClose = -1;
  client.onClose(() => {
    bufferedAtClose = client.buffered;
  });

  client.close();

  assert.equal(bufferedAtClose, 0, "onClose observed a released, self-consistent outbound buffer");
  assert.equal(client.buffered, 0, "close() cleared the outbound ring");
});

test("close() releases the outbound buffer BEFORE the transport's synchronous onClose can surface it", () => {
  // A transport seam is injectable and may legally fire onClose *synchronously*
  // from close() (as FakeTransport does when open). This one always does so,
  // even while the client still holds a backlog — the exact window round 11's
  // handleClose reorder did NOT cover, because that path runs AFTER
  // transport.close(). An onClose subscriber must still observe the released,
  // self-consistent terminal state, not a stale non-zero backlog.
  let hooks: TransportHooks | undefined;
  const syncCloseTransport: TransportFactory = (_url, h) => {
    hooks = h;
    return {
      send() {
        throw new Error("never open: force the client to buffer");
      },
      close() {
        // Fire onClose synchronously from within close(), like an open WebSocket
        // that resolves its close on the same tick would be free to do.
        h.onClose({ local: true });
      },
    };
  };

  const client = new AgenticClient({
    url: "ws://test/agentic",
    instance: "worker-1",
    transport: syncCloseTransport,
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
    capability: { cognition: "high" },
  });
  client.connect(); // builds the transport; it never opens, so frames buffer
  assert.ok(hooks !== undefined, "transport factory was invoked on connect()");

  for (let i = 0; i < 4; i++) {
    client.relay("stdout", `chunk-${i}`);
  }
  assert.ok(client.buffered > 0, "frames buffered while the channel is down");

  let bufferedAtClose = -1;
  client.onClose(() => {
    if (bufferedAtClose === -1) {
      bufferedAtClose = client.buffered; // capture the FIRST close the subscriber sees
    }
  });

  client.close(); // transport.close() fires onClose synchronously, before handleClose

  assert.equal(
    bufferedAtClose,
    0,
    "the transport's synchronous onClose observed a released outbound buffer",
  );
  assert.equal(client.buffered, 0, "close() cleared the outbound ring");
});

test("construction rejects timing/backoff options Node would coerce into a 0ms hot loop", () => {
  // Node's setTimeout/setInterval treat a negative or NaN delay as 0, which would
  // turn a misconfigured heartbeat or reconnect backoff into an event-loop-saturating
  // tight loop. The client must fail fast at construction — the same fail-fast
  // contract OutboundRing enforces on capacity — rather than degrade silently.
  const base = { url: "ws://test/agentic", transport: fakeTransportFactory().factory };

  assert.throws(() => new AgenticClient({ ...base, heartbeatIntervalMs: -1 }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, heartbeatIntervalMs: Number.NaN }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, serveTimeoutMs: -5 }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, serveTimeoutMs: Number.NaN }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, reconnect: { initialDelayMs: -1 } }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, reconnect: { initialDelayMs: Number.NaN } }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, reconnect: { maxDelayMs: -1 } }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, reconnect: { maxDelayMs: Number.POSITIVE_INFINITY } }), RangeError);
  // A backoff factor < 1 shrinks the delay toward 0 on every retry — also a hot loop.
  assert.throws(() => new AgenticClient({ ...base, reconnect: { factor: 0.5 } }), RangeError);
  assert.throws(() => new AgenticClient({ ...base, reconnect: { factor: Number.NaN } }), RangeError);

  // The disabling sentinels stay legal: heartbeat 0 (off) and serveTimeout 0 (no timeout).
  assert.doesNotThrow(() => new AgenticClient({ ...base, heartbeatIntervalMs: 0, serveTimeoutMs: 0 }));
});

test("a throwing onError subscriber can't crash internal error handling or starve siblings", () => {
  // emitError runs inside internal error handling (e.g. a malformed inbound
  // frame). A subscriber that throws there must be contained: it must neither
  // propagate out of the handler (which could take the worker down) nor stop
  // sibling subscribers from receiving the error.
  const { client, t } = newClient();
  client.connect();
  t.last().fireOpen();

  const seen: Error[] = [];
  client.onError(() => {
    throw new Error("subscriber blew up");
  });
  client.onError((e) => seen.push(e));

  // Deliver garbage: decode fails and the client calls emitError internally.
  assert.doesNotThrow(() => t.last().deliver(new Uint8Array([0x00, 0x01, 0x02])));

  // The well-behaved sibling still received the decode error despite the
  // earlier subscriber throwing, and the client is still usable afterwards.
  assert.equal(seen.length, 1);
  client.heartbeat();
  assert.ok(t.last().sentFrames.some((f) => f.family === "heartbeat"));
  client.close();
});

test("a throwing non-error subscriber is contained and doesn't starve siblings", () => {
  // The containment contract is uniform across every emit* fan-out, not just
  // onError: one bad frame subscriber must not break dispatch to the rest.
  const { client, t } = newClient({ serveTimeoutMs: 1000 });
  client.connect();
  t.last().fireOpen();

  const frames: Frame[] = [];
  client.onFrame(() => {
    throw new Error("frame subscriber blew up");
  });
  client.onFrame((f) => frames.push(f));

  assert.doesNotThrow(() => t.last().deliver(serveFrame("worker-1", ["planning.spar"])));
  assert.equal(frames.length, 1);
  client.close();
});

test("close() is terminal even when a prior send-failure already consumed the close guard", () => {
  // A send failure routes through forceReconnect({ local: false }) → handleClose,
  // which sets closeHandled = true and (with reconnect enabled) leaves the client
  // in "connecting" while a reconnect is scheduled. If the caller then calls
  // close() during that window, handleClose early-returns on the closeHandled
  // guard — so close() must enforce the terminal "closed" state itself. Otherwise
  // isClosed stays false, post-close calls could buffer frames again, and (since
  // closedByCaller is now set) the scheduled reconnect skips openTransport, wedging
  // the client in "connecting" forever.
  const scheduled: Array<() => void> = [];
  const { client, t } = newClient({
    reconnect: { enabled: true, initialDelayMs: 10 },
    schedule: (fn) => scheduled.push(fn),
  });
  client.connect();
  t.last().fireOpen();

  // Arm and trigger a send failure: forceReconnect drives handleClose, which
  // consumes the closeHandled guard and schedules a reconnect (captured, unfired).
  t.last().throwOnSend = true;
  client.relay("stdout", "boom");
  assert.equal(client.connectionState, "connecting", "send failure left the client reconnecting");
  assert.equal(scheduled.length, 1, "a reconnect was scheduled");

  // Now the caller closes during the reconnect window.
  client.close();
  assert.equal(client.connectionState, "closed", "close() enforces the terminal state");

  // Firing the previously-scheduled reconnect must not resurrect the closed client.
  scheduled[0]?.();
  assert.equal(client.connectionState, "closed", "a scheduled reconnect can't reopen a closed client");
});
