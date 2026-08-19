import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessageLine, inMemoryTransportPair, NewlineJsonDecoder } from "./transport.ts";

test("NewlineJsonDecoder emits one message per complete line and ignores blanks", () => {
  const messages: unknown[] = [];
  const decoder = new NewlineJsonDecoder(
    (m) => messages.push(m),
    (e) => {
      throw e;
    },
  );
  decoder.push('{"a":1}\n\n{"b":2}\n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test("NewlineJsonDecoder buffers a line split across chunks", () => {
  const messages: unknown[] = [];
  const decoder = new NewlineJsonDecoder(
    (m) => messages.push(m),
    (e) => {
      throw e;
    },
  );
  decoder.push('{"partial":');
  assert.deepEqual(messages, [], "no complete line yet");
  decoder.push('true}\n');
  assert.deepEqual(messages, [{ partial: true }]);
});

test("NewlineJsonDecoder routes an unparseable line to onError without aborting", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const decoder = new NewlineJsonDecoder(
    (m) => messages.push(m),
    (e) => errors.push(e),
  );
  decoder.push("not json\n{\"ok\":1}\n");
  assert.equal(errors.length, 1);
  assert.deepEqual(messages, [{ ok: 1 }], "the stream continues past the bad line");
});

test("encodeMessageLine produces exactly one newline-terminated JSON line", () => {
  const line = encodeMessageLine({ jsonrpc: "2.0", id: 1 });
  assert.equal(line, '{"jsonrpc":"2.0","id":1}\n');
});

test("encodeMessageLine throws on a non-JSON-serialisable message instead of emitting a bad wire line", () => {
  // `JSON.stringify(undefined)` returns `undefined`; a naive template would emit
  // the literal line "undefined\n", which always fails JSON.parse on the peer.
  assert.throws(() => encodeMessageLine(undefined), /non-JSON-serialisable/);
});

test("inMemoryTransportPair delivers what one side sends to the other, asynchronously", async () => {
  const { client, agent } = inMemoryTransportPair();
  const received: unknown[] = [];
  agent.onMessage((m) => received.push(m));
  agent.onError((e) => {
    throw e;
  });
  client.send({ hello: "agent" });
  assert.deepEqual(received, [], "delivery is deferred to a microtask, never synchronous");
  await Promise.resolve();
  assert.deepEqual(received, [{ hello: "agent" }]);
});
