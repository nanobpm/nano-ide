/**
 * Cross-package contract test: the REAL worker client's produced relay frames,
 * as they go on the wire, must be accepted by the REAL hub relay state machine.
 *
 * This is the test that was missing when the agentic-protocol epic (S0–S10)
 * landed: the hub relay-family adopted an op-tagged `produce`/`incarnation`
 * sub-protocol while this client kept emitting the legacy `{ stream, offset,
 * chunk }` delivery shape, so every worker chunk was rejected at the hub as
 * "malformed relay message payload". Each side's own unit tests were green
 * because each mocked the other; nothing fed a real producer frame into the
 * real hub. This test closes that gap and fails if the produce frame drifts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayHub } from "@nanobpm/agentic/source/relay";
import type { RelayConnection } from "@nanobpm/agentic/source/relay";
import type { Frame } from "./protocol.ts";
import { AgenticClient } from "./client.ts";
import { fakeTransportFactory } from "./testkit.ts";

class FakeRegistry {
  readonly live = new Set<string>();
  has(id: string): boolean {
    return this.live.has(id);
  }
}

class FakeConn implements RelayConnection {
  readonly id: string;
  readonly registry: FakeRegistry;
  readonly sent: Frame[] = [];
  constructor(id: string, registry: FakeRegistry) {
    this.id = id;
    this.registry = registry;
    registry.live.add(id);
  }
  send(frame: Frame): void {
    this.sent.push(frame);
  }
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined;
}

/** Data chunks the hub delivered to a consumer, in order. */
function dataChunks(conn: FakeConn): string[] {
  return conn.sent
    .filter((f) => f.lane === "bulk" && field(f.payload, "op") === undefined)
    .map((f) => String(field(f.payload, "chunk")));
}

function subscribeFrame(stream: string, from: number, credit: number): Frame {
  return { lane: "control", family: "relay", seq: 0, payload: { op: "subscribe", stream, from, credit } };
}

function producedRelayFrames(chunks: string[], incarnation: number): Frame[] {
  const t = fakeTransportFactory();
  const client = new AgenticClient({
    url: "ws://test/agentic",
    instance: "worker-1",
    transport: t.factory,
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
    incarnation,
  });
  client.connect();
  t.last().fireOpen();
  for (const c of chunks) client.relay("job-1", c);
  // sentFrames decodes the actual wire bytes the client emitted — a true
  // producer-wire round-trip, not a peek at the pre-encode payload object.
  const relays = t.last().sentFrames.filter((f) => f.family === "relay");
  client.close();
  return relays;
}

test("the hub admits the client's produced relay frames and delivers the bytes", () => {
  const produced = producedRelayFrames(["hello ", "world"], 42);
  assert.equal(produced.length, 2);
  // Every produced frame is an op-tagged `produce` frame (the `produce` payload
  // op — carried on the bulk lane, not the QoS control lane).
  for (const f of produced) {
    assert.equal(field(f.payload, "op"), "produce");
    assert.equal(field(f.payload, "incarnation"), 42);
  }

  const errors: unknown[] = [];
  const hub = new RelayHub({ onError: (e) => errors.push(e) });
  const reg = new FakeRegistry();
  const prod = new FakeConn("producer", reg);
  const cons = new FakeConn("consumer", reg);

  hub.handle(subscribeFrame("job-1", 0, 1024), cons);
  for (const f of produced) hub.handle(f, prod);

  // The regression: before the fix, each produce frame tripped
  // RelayMessageError("malformed relay message payload") here.
  assert.deepEqual(errors, [], "hub rejected a produced relay frame");
  assert.deepEqual(dataChunks(cons), ["hello ", "world"]);
  assert.equal(hub.ring("job-1")?.nextOffset, 2);
});

test("a later producer incarnation fences a stale predecessor on the hub", () => {
  const stale = producedRelayFrames(["from-old"], 1);
  const fresh = producedRelayFrames(["from-new"], 2);

  const fenced: Array<{ stream: string; incarnation: number; current: number }> = [];
  const hub = new RelayHub({ onFenced: (stream, incarnation, current) => fenced.push({ stream, incarnation, current }) });
  const reg = new FakeRegistry();
  const prod = new FakeConn("producer", reg);

  // The fresh (higher) incarnation takes over the stream; the stale one is fenced.
  for (const f of fresh) hub.handle(f, prod);
  for (const f of stale) hub.handle(f, prod);

  assert.equal(hub.ring("job-1")?.nextOffset, 1, "only the fresh incarnation's byte was admitted");
  assert.equal(fenced.length, 1);
  assert.deepEqual(fenced[0], { stream: "job-1", incarnation: 1, current: 2 });
});
