import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFrame, encodeFrame, type Frame } from "@nanobpm/agentic-protocol";

import { RelayChannelClient } from "./relay-client.ts";
import type { RawSocket } from "./relay-client.ts";
import type { RelayInbound } from "./terminal-session.ts";

class FakeSocket implements RawSocket {
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
  deliver(frame: Frame): void {
    this.#onMessage?.(encodeFrame(frame));
  }
  lastSentFrame(): Frame {
    const bytes = this.sent.at(-1);
    assert.ok(bytes !== undefined, "expected a sent frame");
    return decodeFrame(bytes);
  }
}

test("sendRelay encodes a relay message as a control-lane relay frame", () => {
  const socket = new FakeSocket();
  const client = new RelayChannelClient({ connect: () => socket, onRelay: () => {} });
  client.open();
  client.sendRelay({ op: "subscribe", stream: "w1", from: 3, credit: 128 });

  const frame = socket.lastSentFrame();
  assert.equal(frame.family, "relay");
  assert.equal(frame.lane, "control");
  assert.deepEqual(frame.payload, { op: "subscribe", stream: "w1", from: 3, credit: 128 });
});

test("inbound relay data and ack frames are routed to onRelay", () => {
  const socket = new FakeSocket();
  const received: RelayInbound[] = [];
  const client = new RelayChannelClient({ connect: () => socket, onRelay: (m) => received.push(m) });
  client.open();

  socket.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "w1", offset: 7, chunk: "hi" } });
  socket.deliver({ lane: "control", family: "relay", seq: 1, payload: { op: "subscribed", stream: "w1", gap: false, nextOffset: 8 } });

  assert.deepEqual(received, [
    { stream: "w1", offset: 7, chunk: "hi" },
    { op: "subscribed", stream: "w1", gap: false, nextOffset: 8 },
  ]);
});

test("frames of other families are ignored", () => {
  const socket = new FakeSocket();
  const received: RelayInbound[] = [];
  const client = new RelayChannelClient({ connect: () => socket, onRelay: (m) => received.push(m) });
  client.open();
  socket.deliver({ lane: "control", family: "heartbeat", seq: 0, payload: { instance: "w1" } });
  assert.equal(received.length, 0);
});

test("a malformed relay payload reports an error and is not routed", () => {
  const socket = new FakeSocket();
  const received: RelayInbound[] = [];
  const errors: unknown[] = [];
  const client = new RelayChannelClient({
    connect: () => socket,
    onRelay: (m) => received.push(m),
    onError: (e) => errors.push(e),
  });
  client.open();
  socket.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "w1" } });
  assert.equal(received.length, 0);
  assert.equal(errors.length, 1);
});

test("the hub's boolean-gap subscribed ack is accepted (matches the S5 wire)", () => {
  const socket = new FakeSocket();
  const received: RelayInbound[] = [];
  const errors: unknown[] = [];
  const client = new RelayChannelClient({
    connect: () => socket,
    onRelay: (m) => received.push(m),
    onError: (e) => errors.push(e),
  });
  client.open();
  socket.deliver({ lane: "control", family: "relay", seq: 0, payload: { op: "subscribed", stream: "w1", gap: true, nextOffset: 3 } });
  assert.deepEqual(received, [{ op: "subscribed", stream: "w1", gap: true, nextOffset: 3 }]);
  assert.equal(errors.length, 0);
});

test("a non-integer or negative offset/nextOffset is rejected as malformed", () => {
  const socket = new FakeSocket();
  const received: RelayInbound[] = [];
  const errors: unknown[] = [];
  const client = new RelayChannelClient({
    connect: () => socket,
    onRelay: (m) => received.push(m),
    onError: (e) => errors.push(e),
  });
  client.open();
  socket.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "w1", offset: 1.5, chunk: "x" } });
  socket.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "w1", offset: -1, chunk: "x" } });
  socket.deliver({ lane: "control", family: "relay", seq: 2, payload: { op: "subscribed", stream: "w1", gap: false, nextOffset: -1 } });
  assert.equal(received.length, 0);
  assert.equal(errors.length, 3);
});

test("onOpen fires on every (re)connect so the session re-attaches and resumes", () => {
  const sockets: FakeSocket[] = [];
  let pending: (() => void) | undefined;
  const opens: number[] = [];
  const client = new RelayChannelClient({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onRelay: () => {},
    onOpen: () => opens.push(sockets.length),
    schedule: (run) => {
      pending = run;
    },
  });

  client.open();
  sockets[0]?.fireOpen();
  assert.deepEqual(opens, [1]); // first connect

  // The socket drops → the client schedules a reconnect.
  sockets[0]?.fireClose();
  assert.equal(sockets.length, 1, "no new socket until the scheduler runs");
  assert.ok(pending !== undefined, "a reconnect was scheduled");

  pending?.(); // run the scheduled reconnect
  assert.equal(sockets.length, 2, "a fresh socket was opened");
  sockets[1]?.fireOpen();
  assert.deepEqual(opens, [1, 2]); // reconnect fires onOpen again → resume
});

test("close() tears down the socket and suppresses reconnect", () => {
  const sockets: FakeSocket[] = [];
  let pending: (() => void) | undefined;
  const client = new RelayChannelClient({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onRelay: () => {},
    schedule: (run) => {
      pending = run;
    },
  });
  client.open();
  client.close();
  assert.equal(sockets[0]?.closed, true);
  assert.equal(client.isClosed, true);

  // A close event after an explicit close must not schedule a reconnect.
  sockets[0]?.fireClose();
  assert.equal(pending, undefined);
});

test("autoReconnect:false does not reconnect on drop", () => {
  const sockets: FakeSocket[] = [];
  let scheduled = false;
  const client = new RelayChannelClient({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onRelay: () => {},
    autoReconnect: false,
    schedule: () => {
      scheduled = true;
    },
  });
  client.open();
  sockets[0]?.fireClose();
  assert.equal(scheduled, false);
  assert.equal(sockets.length, 1);
});
