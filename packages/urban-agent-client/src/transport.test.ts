import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverIncoming, normaliseIncoming, websocketTransport } from "./transport.ts";
import type { TransportHooks } from "./transport.ts";

test("normaliseIncoming accepts every binary shape a WebSocket may deliver", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  assert.deepEqual([...(normaliseIncoming(bytes) ?? [])], [1, 2, 3, 4]);
  assert.deepEqual([...(normaliseIncoming(bytes.buffer) ?? [])], [1, 2, 3, 4]);

  const view = new DataView(bytes.buffer, 1, 2);
  assert.deepEqual([...(normaliseIncoming(view) ?? [])], [2, 3]);

  const buffer = Buffer.from([9, 8, 7]);
  assert.deepEqual([...(normaliseIncoming(buffer) ?? [])], [9, 8, 7]);
});

test("normaliseIncoming returns undefined for a text (non-binary) message", () => {
  assert.equal(normaliseIncoming("hello"), undefined);
  assert.equal(normaliseIncoming(42), undefined);
  assert.equal(normaliseIncoming(null), undefined);
});

test("websocketTransport builds a Transport and refuses to send before the socket is open", () => {
  const hooks: TransportHooks = {
    onOpen: () => {},
    onFrame: () => {},
    onClose: () => {},
    onError: () => {},
  };
  // A syntactically valid but unconnected URL: the socket starts CONNECTING, so
  // a send must throw rather than silently drop the frame (which lets the client
  // buffer it). We never actually establish the connection.
  const transport = websocketTransport("ws://127.0.0.1:9/agentic", hooks);
  assert.equal(typeof transport.send, "function");
  assert.equal(typeof transport.close, "function");
  assert.throws(() => transport.send(new Uint8Array([1])), /not open/);
  transport.close();
});

test("websocketTransport surfaces a non-binary inbound message via onError instead of dropping it", () => {
  const frames: Uint8Array[] = [];
  const errors: Error[] = [];
  const hooks = {
    onFrame: (bytes: Uint8Array) => frames.push(bytes),
    onError: (error: Error) => errors.push(error),
  };

  // A binary frame is delivered to onFrame.
  deliverIncoming(new Uint8Array([1, 2, 3]), hooks);
  // A text frame is a protocol violation — surfaced via onError, not dropped.
  deliverIncoming("not-binary", hooks);

  assert.equal(frames.length, 1, "the binary frame reached onFrame");
  assert.deepEqual([...(frames[0] ?? [])], [1, 2, 3]);
  assert.equal(errors.length, 1, "the non-binary frame was surfaced via onError");
  assert.match(errors[0]?.message ?? "", /non-binary message/);
});
