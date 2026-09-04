import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFrame, encodeFrame, type Frame } from "../protocol/index.ts";
import { MESSAGE_FAMILIES } from "../protocol/index.ts";

import {
  AgenticEmitClient,
  transcriptStreamKey,
  type HostSocket,
} from "./emit-client.ts";

class FakeSocket implements HostSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onOpen: (() => void) | undefined;
  #onClose: (() => void) | undefined;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#onMessage = listener;
  }
  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }
  onClose(listener: () => void): void {
    this.#onClose = listener;
  }
  fireOpen(): void {
    this.#onOpen?.();
  }
  fireClose(): void {
    this.#onClose?.();
  }
  deliver(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
  }
  frames(): Frame[] {
    return this.sent.map((bytes) => decodeFrame(bytes));
  }
}

/** A manual scheduler that runs queued reconnects only when explicitly drained —
 * no real timers, deterministic ordering (AGENTS.md: no flaky tests). */
class ManualScheduler {
  readonly #queue: Array<() => void> = [];
  schedule = (run: () => void): void => {
    this.#queue.push(run);
  };
  drain(): void {
    while (this.#queue.length > 0) {
      const run = this.#queue.shift();
      run?.();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadInstance(frame: Frame): string | undefined {
  return isRecord(frame.payload) && typeof frame.payload.instance === "string"
    ? frame.payload.instance
    : undefined;
}

test("N instances register + heartbeat over ONE connection, each tagged explicitly", () => {
  let opened = 0;
  const socket = new FakeSocket();
  const client = new AgenticEmitClient({
    connect: () => {
      opened += 1;
      return socket;
    },
  });
  client.open();
  socket.fireOpen();

  client.register("w1", { cognition: "opus", weight: 1 });
  client.register("w2", { cognition: "sonnet" });
  client.register("w3", {});
  client.heartbeat("w1");
  client.heartbeat("w2");
  client.heartbeat("w3");

  assert.equal(opened, 1, "exactly one connection is opened for all instances");
  assert.deepEqual([...client.instances()].sort(), ["w1", "w2", "w3"]);

  const frames = socket.frames();
  const registers = frames.filter((f) => f.family === "register");
  const heartbeats = frames.filter((f) => f.family === "heartbeat");
  assert.deepEqual(registers.map(payloadInstance), ["w1", "w2", "w3"]);
  assert.deepEqual(heartbeats.map(payloadInstance), ["w1", "w2", "w3"]);
  // seq is monotonic across the multiplexed connection.
  assert.deepEqual(
    frames.map((f) => f.seq),
    frames.map((_, i) => i),
  );
});

test("claim/release per instance are tracked and idempotent-safe", () => {
  const socket = new FakeSocket();
  const client = new AgenticEmitClient({ connect: () => socket });
  client.open();
  socket.fireOpen();

  client.register("w1", {});
  client.register("w2", {});
  client.claim("w1", "job-A");
  client.claim("w2", "job-B");
  client.claim("w1", "job-C");
  assert.deepEqual([...client.claimsOf("w1")].sort(), ["job-A", "job-C"]);
  assert.deepEqual(client.claimsOf("w2"), ["job-B"]);

  client.release("w1", "job-A");
  assert.deepEqual(client.claimsOf("w1"), ["job-C"]);
  // Releasing an unheld job is a no-op re-assertion (still emits, no throw).
  client.release("w1", "job-A");
  assert.deepEqual(client.claimsOf("w1"), ["job-C"]);

  const claims = socket.frames().filter((f) => f.family === "claim");
  assert.equal(claims.length, 3);
  const releases = socket.frames().filter((f) => f.family === "release");
  assert.equal(releases.length, 2);
});

test("reconnect re-registers all instances and re-claims all in-flight jobs, before transcript", () => {
  const scheduler = new ManualScheduler();
  let socket = new FakeSocket();
  const client = new AgenticEmitClient({
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    schedule: scheduler.schedule,
  });
  client.open();
  socket.fireOpen();

  client.register("w1", { cognition: "opus" });
  client.register("w2", { cognition: "sonnet" });
  client.claim("w1", "job-A");
  client.claim("w1", "job-B");
  client.claim("w2", "job-C");

  // Drop the connection; a reconnect is scheduled.
  socket.fireClose();
  scheduler.drain();
  const reconnected = socket;
  reconnected.fireOpen();

  // Any transcript emitted after the resync must follow the ownership frames.
  client.transcript("w1", "stdout", "hello");

  const frames = reconnected.frames();
  const registers = frames.filter((f) => f.family === "register").map(payloadInstance);
  assert.deepEqual(registers.sort(), ["w1", "w2"], "all instances re-registered on reconnect");

  const claimKeys = frames
    .filter((f) => f.family === "claim")
    .map((f) => (isRecord(f.payload) ? f.payload.jobKey : undefined));
  assert.deepEqual(claimKeys.sort(), ["job-A", "job-B", "job-C"], "all in-flight jobs re-claimed");

  // Ordering: every register+claim precedes the first transcript (relay) frame.
  const firstRelay = frames.findIndex((f) => f.family === "relay");
  const lastOwnership = frames.reduce(
    (acc, f, i) => (f.family === "register" || f.family === "claim" ? i : acc),
    -1,
  );
  assert.ok(firstRelay > lastOwnership, "transcript resumes only after presence + ownership re-asserted");
});

test("reconnect bumps the producer incarnation so a stale predecessor is fenced", () => {
  const scheduler = new ManualScheduler();
  let socket = new FakeSocket();
  const client = new AgenticEmitClient({
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    schedule: scheduler.schedule,
  });
  client.open();
  socket.fireOpen();
  client.register("w1", {});
  client.transcript("w1", "stdout", "gen-1");
  const firstGen = client.generation;

  socket.fireClose();
  scheduler.drain();
  socket.fireOpen();
  client.transcript("w1", "stdout", "gen-2");

  assert.equal(client.generation, firstGen + 1);
  const relay = socket.frames().filter((f) => f.family === "relay");
  const incarnation = isRecord(relay[0]?.payload) ? relay[0].payload.incarnation : undefined;
  assert.equal(incarnation, firstGen + 1, "resumed transcript carries the strictly-higher incarnation");
});

test("deregister on departure emits and stops resync from re-asserting the instance", () => {
  const scheduler = new ManualScheduler();
  let socket = new FakeSocket();
  const client = new AgenticEmitClient({
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    schedule: scheduler.schedule,
  });
  client.open();
  socket.fireOpen();
  client.register("w1", {});
  client.register("w2", {});
  client.claim("w1", "job-A");

  client.deregister("w1", "done");
  assert.deepEqual(client.instances(), ["w2"]);
  const dereg = socket.frames().find((f) => f.family === "deregister");
  assert.equal(payloadInstance(dereg ?? { lane: "control", family: "deregister", seq: 0, payload: {} }), "w1");

  socket.fireClose();
  scheduler.drain();
  socket.fireOpen();
  const reRegistered = socket.frames().filter((f) => f.family === "register").map(payloadInstance);
  assert.deepEqual(reRegistered, ["w2"], "departed instance is not re-registered");
  const reClaimed = socket.frames().filter((f) => f.family === "claim");
  assert.equal(reClaimed.length, 0, "departed instance's claims are not re-asserted");
});

test("per-instance transcript isolation: two instances' identically-named streams never cross", () => {
  const socket = new FakeSocket();
  const client = new AgenticEmitClient({ connect: () => socket });
  client.open();
  socket.fireOpen();
  client.register("w1", {});
  client.register("w2", {});

  client.transcript("w1", "stdout", "from-w1");
  client.transcript("w2", "stdout", "from-w2");

  const streams = socket
    .frames()
    .filter((f) => f.family === "relay")
    .map((f) => (isRecord(f.payload) ? f.payload.stream : undefined));
  assert.deepEqual(streams, [transcriptStreamKey("w1", "stdout"), transcriptStreamKey("w2", "stdout")]);
  assert.notEqual(streams[0], streams[1], "the two wire streams are disjoint");
});

test("legacy peer degrades unsupported families/features to no-ops", () => {
  const socket = new FakeSocket();
  // A legacy hub that never learned claim/release (families 8/9) nor the feature.
  const legacy = {
    version: 1,
    families: MESSAGE_FAMILIES.filter((f) => f !== "claim" && f !== "release"),
    features: [],
  };
  const client = new AgenticEmitClient({ connect: () => socket, remote: legacy });
  client.open();
  socket.fireOpen();

  client.register("w1", {});
  client.heartbeat("w1");
  client.claim("w1", "job-A"); // unsupported -> no-op on the wire

  const families = socket.frames().map((f) => f.family);
  assert.deepEqual(families, ["register", "heartbeat"], "claim/release never hit the wire against a legacy peer");
  // But client state still tracks the claim locally (it can be re-asserted once
  // a capable peer is negotiated).
  assert.deepEqual(client.claimsOf("w1"), ["job-A"]);

  // release is likewise a wire no-op against the legacy peer.
  client.release("w1", "job-A");
  assert.deepEqual(
    socket.frames().map((f) => f.family),
    ["register", "heartbeat"],
    "release also stays off the wire against a legacy peer",
  );

  // Once a capable peer is negotiated, ownership frames flow again.
  client.applyRemoteAdvertisement({
    version: 1,
    families: MESSAGE_FAMILIES,
    features: ["claim-release", "multi-instance"],
  });
  client.claim("w1", "job-B");
  assert.ok(
    socket.frames().some((f) => f.family === "claim"),
    "claim reaches the wire after negotiating a capable peer",
  );
});

test("emits are dropped (not thrown) before the socket opens and after close", () => {
  const socket = new FakeSocket();
  const client = new AgenticEmitClient({ connect: () => socket, autoReconnect: false });
  // Before open(): no socket yet — the emit is dropped (not thrown), though the
  // instance is tracked so a later connect resyncs it.
  client.register("w1", {});
  assert.equal(socket.sent.length, 0);
  assert.deepEqual(client.instances(), ["w1"]);

  client.open();
  socket.fireOpen();
  // Resync re-registers the pre-tracked instance on connect.
  assert.deepEqual(
    socket.frames().map((f) => f.family),
    ["register"],
  );

  client.close();
  assert.equal(socket.closed, true);
  assert.equal(client.isClosed, true);
  client.heartbeat("w1"); // after close: no-op, no throw
  assert.equal(socket.frames().length, 1);
});

test("a throwing connect factory is routed to onError and reconnect survives", () => {
  const scheduler = new ManualScheduler();
  const errors: unknown[] = [];
  let attempts = 0;
  const good = new FakeSocket();
  const client = new AgenticEmitClient({
    connect: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connect boom");
      return good;
    },
    schedule: scheduler.schedule,
    onError: (err) => errors.push(err),
  });
  client.open();
  assert.equal(errors.length, 1, "the synchronous connect failure is surfaced");
  scheduler.drain(); // retry
  good.fireOpen();
  client.register("w1", {});
  assert.equal(good.frames().length, 1, "the client recovered onto the second socket");
});

test("inbound frames are decoded and routed to onFrame; garbage goes to onError", () => {
  const socket = new FakeSocket();
  const seen: Frame[] = [];
  const errors: unknown[] = [];
  const client = new AgenticEmitClient({
    connect: () => socket,
    onFrame: (f) => seen.push(f),
    onError: (err) => errors.push(err),
  });
  client.open();
  socket.fireOpen();

  const inbound: Frame = { lane: "control", family: "serve", seq: 0, payload: { instance: "w1", tokens: [] } };
  socket.deliver(encodeFrame(inbound));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.family, "serve");

  socket.deliver(new Uint8Array([1, 2, 3]));
  assert.equal(errors.length, 1, "an undecodable inbound frame is surfaced, not thrown");
});

test("transcriptStreamKey is injective even when a component contains the separator", () => {
  const sep = "\u001f";
  // Without an injective join these two distinct (instance, stream) pairs would
  // both compose to `a<sep>b<sep>c`, colliding and breaking per-instance isolation.
  const a = transcriptStreamKey(`a${sep}b`, "c");
  const b = transcriptStreamKey("a", `b${sep}c`);
  assert.notEqual(a, b, "distinct (instance, stream) pairs must yield distinct keys");

  // The escape char itself must not open a second collision channel.
  const c = transcriptStreamKey("a\\", "b");
  const d = transcriptStreamKey("a", "\\b");
  assert.notEqual(c, d, "the escape char is itself escaped, so it cannot forge a separator");
});
