import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeFrame,
  MESSAGE_FAMILIES,
  type Frame,
  type MessageFamily,
  type ProtocolAdvertisement,
} from "../protocol/index.ts";

import { AgenticEmitClient, composeStreamId } from "./emit-client.ts";
import type { EmitSocket } from "./emit-client.ts";

/** An in-memory duplex socket that records every frame the client sends. */
class FakeSocket implements EmitSocket {
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

  /** Decode every recorded frame. */
  frames(): Frame[] {
    return this.sent.map((bytes) => decodeFrame(bytes));
  }
}

/** A harness that hands out fresh {@link FakeSocket}s and runs reconnects synchronously. */
function harness(options?: {
  peerAdvertisement?: ProtocolAdvertisement | unknown;
  onOpen?: (client: AgenticEmitClient) => void;
}) {
  const sockets: FakeSocket[] = [];
  const client = new AgenticEmitClient({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    peerAdvertisement: options?.peerAdvertisement,
    schedule: (run) => run(),
    onOpen: options?.onOpen ? () => options.onOpen?.(client) : undefined,
  });
  return { client, sockets, current: () => sockets[sockets.length - 1] };
}

function byFamily(frames: Frame[], family: MessageFamily): Frame[] {
  return frames.filter((f) => f.family === family);
}

test("N instances register + heartbeat over ONE connection, each tagged explicitly", () => {
  const { client, sockets, current } = harness();
  client.open();
  current().fireOpen();

  client.register("inst-a", { cognition: "opus", weight: 3 });
  client.register("inst-b", { cognition: "sonnet" });
  client.register("inst-c", { family: "reviewer" });
  client.heartbeat("inst-a");
  client.heartbeat("inst-b");
  client.heartbeat("inst-c");

  // Exactly one socket was ever opened — the connection is multiplexed.
  assert.equal(sockets.length, 1);

  const frames = current().frames();
  const registers = byFamily(frames, "register");
  const heartbeats = byFamily(frames, "heartbeat");
  assert.deepEqual(
    registers.map((f) => (f.payload as { instance: string }).instance),
    ["inst-a", "inst-b", "inst-c"],
  );
  assert.deepEqual(
    heartbeats.map((f) => (f.payload as { instance: string }).instance),
    ["inst-a", "inst-b", "inst-c"],
  );
  // Capability travels on the register frame.
  assert.deepEqual((registers[0].payload as { capability: unknown }).capability, {
    cognition: "opus",
    weight: 3,
  });
  // Presence rides the control lane, never bulk.
  for (const f of [...registers, ...heartbeats]) assert.equal(f.lane, "control");
  assert.deepEqual(client.instances, ["inst-a", "inst-b", "inst-c"]);
});

test("claim/release per instance, with explicit instance and idempotent tracking", () => {
  const { client, current } = harness();
  client.open();
  current().fireOpen();

  client.claim("inst-a", "job-1");
  client.claim("inst-a", "job-1"); // duplicate re-assertion — still sent, still one tracked
  client.claim("inst-b", "job-2");
  assert.deepEqual(client.inFlight("inst-a"), ["job-1"]);
  assert.deepEqual(client.inFlight("inst-b"), ["job-2"]);

  client.release("inst-a", "job-1");
  client.release("inst-a", "job-1"); // late/duplicate release — no-op tracking
  assert.deepEqual(client.inFlight("inst-a"), []);

  const claims = byFamily(current().frames(), "claim");
  assert.deepEqual(
    claims.map((f) => f.payload),
    [
      { instance: "inst-a", jobKey: "job-1" },
      { instance: "inst-a", jobKey: "job-1" },
      { instance: "inst-b", jobKey: "job-2" },
    ],
  );
  const releases = byFamily(current().frames(), "release");
  assert.deepEqual(
    releases.map((f) => f.payload),
    [
      { instance: "inst-a", jobKey: "job-1" },
      { instance: "inst-a", jobKey: "job-1" },
    ],
  );
});

test("reconnect re-registers all instances and re-claims all in-flight jobs before resuming transcript", () => {
  const resumeOrder: string[] = [];
  const { client, sockets, current } = harness({
    onOpen: (c) => {
      // The caller resumes transcript from onOpen — assert resync already ran.
      c.transcript({ instance: "inst-a", stream: "stdout" }, "resumed");
      resumeOrder.push("onOpen");
    },
  });
  client.open();
  current().fireOpen();

  client.register("inst-a", { cognition: "opus" });
  client.register("inst-b", { cognition: "sonnet" });
  client.claim("inst-a", "job-1");
  client.claim("inst-b", "job-2");
  client.release("inst-b", "job-2"); // finished before the drop — must NOT be re-claimed

  // Drop and reconnect (scheduler runs synchronously).
  current().fireClose();
  assert.equal(sockets.length, 2);
  const reconnected = current();
  reconnected.fireOpen();

  const frames = reconnected.frames();
  // The FIRST frames on the new socket are the resync: both registers, then the
  // one still-in-flight claim — and only THEN the transcript produce from onOpen.
  const controlFamilies = frames
    .filter((f) => f.family === "register" || f.family === "claim" || f.family === "relay")
    .map((f) => f.family);
  const firstRelay = controlFamilies.indexOf("relay");
  const resyncSlice = controlFamilies.slice(0, firstRelay);
  assert.deepEqual(resyncSlice, ["register", "register", "claim"]);

  const reRegisters = byFamily(frames, "register").map((f) => (f.payload as { instance: string }).instance);
  assert.deepEqual(reRegisters, ["inst-a", "inst-b"]);
  const reClaims = byFamily(frames, "claim").map((f) => f.payload);
  assert.deepEqual(reClaims, [{ instance: "inst-a", jobKey: "job-1" }]); // job-2 was released, not re-claimed

  // Transcript resumed after resync, on the bulk lane, with a bumped incarnation.
  const relays = byFamily(frames, "relay");
  assert.equal(relays.length, 1);
  assert.equal(relays[0].lane, "bulk");
  assert.equal((relays[0].payload as { incarnation: number }).incarnation, 1);
  assert.deepEqual(resumeOrder, ["onOpen", "onOpen"]); // fires on the first connect and the reconnect
});

test("deregister on departure drops the instance and its jobs from resync", () => {
  const { client, sockets, current } = harness();
  client.open();
  current().fireOpen();

  client.register("inst-a", { cognition: "opus" });
  client.claim("inst-a", "job-1");
  client.deregister("inst-a", "shutdown");
  assert.deepEqual(client.instances, []);
  assert.deepEqual(client.inFlight("inst-a"), []);

  const dereg = byFamily(current().frames(), "deregister");
  assert.deepEqual(dereg.map((f) => f.payload), [{ instance: "inst-a", reason: "shutdown" }]);

  // After a reconnect a departed instance is NOT resurrected.
  current().fireClose();
  const reconnected = sockets[sockets.length - 1];
  reconnected.fireOpen();
  assert.equal(byFamily(reconnected.frames(), "register").length, 0);
  assert.equal(byFamily(reconnected.frames(), "claim").length, 0);
});

test("per-instance transcript isolation: two instances' streams never cross", () => {
  const { client, current } = harness();
  client.open();
  current().fireOpen();

  client.transcript({ instance: "inst-a", stream: "stdout" }, "a-out");
  client.transcript({ instance: "inst-b", stream: "stdout" }, "b-out");

  const relays = byFamily(current().frames(), "relay");
  const streams = relays.map((f) => (f.payload as { stream: string }).stream);
  assert.equal(new Set(streams).size, 2, "same stream name on two instances must not collide");
  assert.notEqual(streams[0], streams[1]);
  assert.equal(streams[0], composeStreamId("inst-a", "stdout"));
  assert.equal(streams[1], composeStreamId("inst-b", "stdout"));

  // The composition is injective even when names contain the delimiter chars.
  assert.notEqual(composeStreamId("a", "b/c"), composeStreamId("a/b", "c"));
  assert.notEqual(composeStreamId("1:x", "y"), composeStreamId("1", "x/y"));
});

test("legacy peer (no claim/release families) degrades claim/release to no-ops", () => {
  // A peer that only knows the base presence families — never learned the
  // ownership frames (codes 8/9).
  const legacy: ProtocolAdvertisement = {
    version: 1,
    families: MESSAGE_FAMILIES.filter((f) => f !== "claim" && f !== "release"),
    features: [],
  };
  const { client, current } = harness({ peerAdvertisement: legacy });
  client.open();
  current().fireOpen();

  assert.equal(client.protocol.supportsFamily("claim"), false);
  assert.equal(client.protocol.supportsFamily("register"), true);

  client.register("inst-a", { cognition: "opus" });
  client.heartbeat("inst-a");
  client.claim("inst-a", "job-1"); // no wire frame — but still tracked locally
  client.release("inst-a", "job-1");

  const frames = current().frames();
  assert.equal(byFamily(frames, "claim").length, 0, "claim must not hit the wire for a legacy peer");
  assert.equal(byFamily(frames, "release").length, 0, "release must not hit the wire for a legacy peer");
  assert.equal(byFamily(frames, "register").length, 1);
  assert.equal(byFamily(frames, "heartbeat").length, 1);
});

test("emits nothing before the socket is open; a send fault is routed to onError not thrown", () => {
  let errored: unknown;
  const failing = new AgenticEmitClient({
    connect: () => {
      const s = new FakeSocket();
      s.send = () => {
        throw new Error("boom");
      };
      return s;
    },
    schedule: (run) => run(),
    onError: (e) => {
      errored = e;
    },
  });

  // Before open() there is no socket — register is a silent no-op, no throw.
  failing.register("inst-a", { cognition: "opus" });
  failing.open();
  failing.register("inst-a", { cognition: "opus" }); // send throws → routed to onError
  assert.ok(errored instanceof Error);
  assert.match((errored as Error).message, /boom/);
});
