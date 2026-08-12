import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { decodeFrame, encodeFrame } from "@nanobpm/agentic-protocol";
import type { Frame, MessageFamily } from "@nanobpm/agentic-protocol";
import { AgenticHub, DuplicateFamilyHandlerError, sharedSecretAuthenticator } from "@nanobpm/agentic-channel";
import type { ChannelConnection, ChannelTransport, CloseCode, HandshakeRequest } from "@nanobpm/agentic-channel";
import { attachBlackboardFamily, BlackboardPayloadError, BlackboardScopeError } from "./family.ts";
import { BlackboardStore } from "./store.ts";
import { openTestDb } from "./test-db.ts";

/** In-memory connection the test drives directly, capturing frames sent back. */
class FakeConnection implements ChannelConnection {
  readonly id: string;
  readonly handshake: HandshakeRequest;
  readonly sent: Frame[] = [];
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onClose: ((code?: CloseCode, reason?: string) => void) | undefined;

  constructor(id: string, handshake: HandshakeRequest) {
    this.id = id;
    this.handshake = handshake;
  }
  send(bytes: Uint8Array): void {
    this.sent.push(decodeFrame(bytes));
  }
  close(code?: CloseCode, reason?: string): void {
    this.#onClose?.(code, reason);
  }
  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#onMessage = listener;
  }
  onClose(listener: (code?: CloseCode, reason?: string) => void): void {
    this.#onClose = listener;
  }
  receive(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
  }
}

class FakeTransport implements ChannelTransport {
  readonly address = { port: 0 };
  #onConnection: ((conn: ChannelConnection) => void) | undefined;
  onConnection(listener: (conn: ChannelConnection) => void): void {
    this.#onConnection = listener;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  accept(conn: ChannelConnection): void {
    this.#onConnection?.(conn);
  }
}

function frame(family: MessageFamily, payload: unknown, seq = 1): Uint8Array {
  // Blackboard requests ride the `interactive` lane per the protocol conformance
  // corpus; replies still come back on the `control`/facts lane (see `lastReply`).
  const f: Frame = { lane: "interactive", family, seq, payload };
  return encodeFrame(f);
}

const auth = sharedSecretAuthenticator({ secret: "s3cret" });

/** Connect with a capability credential — the default board scope. */
function connect(transport: FakeTransport, id: string, remote: string, credential = "board-cap"): FakeConnection {
  const conn = new FakeConnection(id, { token: "s3cret", credential, remote });
  transport.accept(conn);
  return conn;
}

/** The single blackboard reply the connection received, decoded cast-free via JSON. */
function lastReply(conn: FakeConnection) {
  const f = conn.sent.at(-1);
  assert.ok(f, "expected a reply frame");
  assert.equal(f.family, "blackboard");
  assert.equal(f.lane, "control", "replies ride the control/facts lane");
  assert.ok(f.payload && typeof f.payload === "object");
  return JSON.parse(JSON.stringify(f.payload));
}

test("append then read round-trips through the S1 seam", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new BlackboardStore(openTestDb());
  attachBlackboardFamily(hub, store);

  const conn = connect(transport, "c1", "peer-a");
  await tick();

  conn.receive(frame("blackboard", { op: "append", authorTask: "t1", kind: "note", body: "hello" }, 1));
  await tick();
  const appendReply = lastReply(conn);
  assert.equal(appendReply.op, "append");
  assert.equal(appendReply.inserted, true);
  assert.equal(appendReply.scope, undefined, "reply must not echo the (secret) capability scope");
  assert.deepEqual(appendReply.conflicts, []);

  conn.receive(frame("blackboard", { op: "read" }, 2));
  await tick();
  const readReply = lastReply(conn);
  assert.equal(readReply.op, "read");
  assert.equal(readReply.scope, undefined, "reply must not echo the (secret) capability scope");
  const entries = readReply.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.body, "hello");
  assert.equal(entries[0]?.authorTask, "t1");
  assert.equal(readReply.cursor, entries[0]?.id);

  await hub.close();
});

test("the read reply echoes the request seq for correlation", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  attachBlackboardFamily(hub, new BlackboardStore(openTestDb()));
  const conn = connect(transport, "c1", "peer-a");
  await tick();

  conn.receive(frame("blackboard", { op: "read" }, 77));
  await tick();
  assert.equal(conn.sent.at(-1)?.seq, 77);

  await hub.close();
});

test("a dedupeKey append is idempotent across a retry over the channel", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new BlackboardStore(openTestDb());
  attachBlackboardFamily(hub, store);
  const conn = connect(transport, "c1", "peer-a");
  await tick();

  conn.receive(frame("blackboard", { op: "append", body: "once", dedupeKey: "k1" }, 1));
  await tick();
  assert.equal(lastReply(conn).inserted, true);

  conn.receive(frame("blackboard", { op: "append", body: "once (retry)", dedupeKey: "k1" }, 2));
  await tick();
  const retry = lastReply(conn);
  assert.equal(retry.inserted, false);
  assert.equal(store.count("board-cap"), 1);

  await hub.close();
});

test("a file-claim append reports a conflict with a prior sibling claim", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  attachBlackboardFamily(hub, new BlackboardStore(openTestDb()));

  // Both peers share the same capability → the same board.
  const a = connect(transport, "c1", "peer-a");
  const b = connect(transport, "c2", "peer-b");
  await tick();

  a.receive(frame("blackboard", { op: "append", authorTask: "t1", kind: "file-claim", files: ["state.rs"], body: "t1" }, 1));
  await tick();
  assert.deepEqual(lastReply(a).conflicts, [], "first claimer sees no conflict");

  b.receive(frame("blackboard", { op: "append", authorTask: "t2", kind: "file-claim", files: ["state.rs"], body: "t2" }, 1));
  await tick();
  const conflicts = lastReply(b).conflicts;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.file, "state.rs");
  assert.equal(conflicts[0]?.authorTask, "t1");

  await hub.close();
});

test("boards are isolated by capability scope", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new BlackboardStore(openTestDb());
  attachBlackboardFamily(hub, store);

  const a = connect(transport, "c1", "peer-a", "cap-A");
  const b = connect(transport, "c2", "peer-b", "cap-B");
  await tick();

  a.receive(frame("blackboard", { op: "append", body: "a-only" }, 1));
  b.receive(frame("blackboard", { op: "append", body: "b-only" }, 1));
  await tick();

  a.receive(frame("blackboard", { op: "read" }, 2));
  await tick();
  const aEntries = lastReply(a).entries;
  assert.deepEqual(aEntries.map((e: { body: string }) => e.body), ["a-only"]);

  b.receive(frame("blackboard", { op: "read" }, 2));
  await tick();
  const bEntries = lastReply(b).entries;
  assert.deepEqual(bEntries.map((e: { body: string }) => e.body), ["b-only"]);

  await hub.close();
});

test("a connection with no capability scope is rejected and never touches the store", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  // Authenticator that grants without requiring a credential, so scope is absent.
  const noCredAuth = sharedSecretAuthenticator({ secret: "s3cret", requireCredential: false });
  const hub = new AgenticHub({ transport, authenticator: noCredAuth, sweepIntervalMs: 0 });
  const store = new BlackboardStore(openTestDb());
  attachBlackboardFamily(hub, store, { onError: (e) => errors.push(e) });

  const conn = new FakeConnection("c1", { token: "s3cret", remote: "peer-a" });
  transport.accept(conn);
  await tick();
  conn.receive(frame("blackboard", { op: "append", body: "x" }, 1));
  await tick();

  assert.equal(store.count(""), 0);
  assert.equal(conn.sent.length, 0, "no reply for a scopeless connection");
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof BlackboardScopeError);

  await hub.close();
});

test("a malformed blackboard payload is rejected and never touches the store", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new BlackboardStore(openTestDb());
  attachBlackboardFamily(hub, store, { onError: (e) => errors.push(e) });
  const conn = connect(transport, "c1", "peer-a");
  await tick();

  // Bad op.
  conn.receive(frame("blackboard", { op: "delete" }, 1));
  await tick();
  // append with a blank body.
  conn.receive(frame("blackboard", { op: "append", body: "   " }, 2));
  await tick();

  assert.equal(store.count("board-cap"), 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e instanceof BlackboardPayloadError));

  await hub.close();
});

test("the blackboard family composes with a second family through the seam", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  attachBlackboardFamily(hub, new BlackboardStore(openTestDb()));
  // A second, distinct family attaches through the same seam with no shared edit.
  const heartbeats: string[] = [];
  hub.registerFamilyHandler("heartbeat", (f) => {
    heartbeats.push(JSON.stringify(f.payload));
  });
  assert.deepEqual(hub.router.families().sort(), ["blackboard", "heartbeat"]);

  const conn = connect(transport, "c1", "peer-a");
  await tick();
  conn.receive(frame("blackboard", { op: "read" }, 1));
  conn.receive(frame("heartbeat", { instance: "w-1" }, 2));
  await tick();

  assert.equal(conn.sent.at(-1)?.family, "blackboard", "the blackboard frame routed to the blackboard handler");
  assert.deepEqual(heartbeats, ['{"instance":"w-1"}'], "the heartbeat frame routed to its own handler");

  await hub.close();
});

test("attaching a second blackboard module to the same hub is rejected", () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  attachBlackboardFamily(hub, new BlackboardStore(openTestDb()));
  assert.throws(() => attachBlackboardFamily(hub, new BlackboardStore(openTestDb())), DuplicateFamilyHandlerError);
});
