import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { decodeFrame, encodeFrame } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";
import { AgenticHub, sharedSecretAuthenticator } from "@nanobpm/agentic-channel";
import type { ChannelConnection, ChannelTransport, CloseCode, HandshakeRequest } from "@nanobpm/agentic-channel";
import { DuplicateFamilyHandlerError } from "@nanobpm/agentic-channel";
import { registerRelayFamily } from "./relay-family.ts";

class FakeConnection implements ChannelConnection {
  readonly id: string;
  readonly handshake: HandshakeRequest;
  readonly sent: Uint8Array[] = [];
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onClose: ((code?: CloseCode, reason?: string) => void) | undefined;
  constructor(id: string, handshake: HandshakeRequest) {
    this.id = id;
    this.handshake = handshake;
  }
  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
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

const HANDSHAKE: HandshakeRequest = { token: "s", credential: "cap" };

function makeHub(): { hub: AgenticHub; transport: FakeTransport } {
  const transport = new FakeTransport();
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: "s", requireCredential: false }),
    sweepIntervalMs: 0,
  });
  return { hub, transport };
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined;
}

function decodedFrames(conn: FakeConnection): Frame[] {
  return conn.sent.map((bytes) => decodeFrame(bytes));
}

test("the relay family attaches via the S1 registerFamilyHandler seam and routes end-to-end", async () => {
  const { hub, transport } = makeHub();
  registerRelayFamily(hub, { defaultCredit: 100 });
  assert.ok(hub.router.has("relay"));

  const producer = new FakeConnection("p", HANDSHAKE);
  const consumer = new FakeConnection("c", HANDSHAKE);
  transport.accept(producer);
  transport.accept(consumer);
  await tick(); // let async auth + registration settle

  consumer.receive(
    encodeFrame({ lane: "control", family: "relay", seq: 1, payload: { op: "subscribe", stream: "t", from: 0, credit: 100 } }),
  );
  producer.receive(
    encodeFrame({ lane: "bulk", family: "relay", seq: 1, payload: { op: "produce", stream: "t", incarnation: 1, chunk: "hello" } }),
  );
  await tick();

  const frames = decodedFrames(consumer);
  const ack = frames.find((f) => field(f.payload, "op") === "subscribed");
  assert.ok(ack, "consumer received the control-lane subscribed ack");
  assert.equal(ack.lane, "control");
  const data = frames.filter((f) => f.lane === "bulk" && field(f.payload, "op") === undefined);
  assert.equal(data.length, 1);
  assert.equal(field(data[0]?.payload, "stream"), "t");
  assert.equal(field(data[0]?.payload, "offset"), 0);
  assert.equal(field(data[0]?.payload, "chunk"), "hello");

  await hub.close();
});

test("registering the relay family twice is rejected by the seam (one owner per family)", () => {
  const { hub } = makeHub();
  registerRelayFamily(hub);
  assert.throws(() => registerRelayFamily(hub), DuplicateFamilyHandlerError);
});

test("a consumer that disconnects is pruned; the producer keeps flowing to the rest", async () => {
  const { hub, transport } = makeHub();
  const relay = registerRelayFamily(hub, { defaultCredit: 100 });

  const producer = new FakeConnection("p", HANDSHAKE);
  const consumer = new FakeConnection("c", HANDSHAKE);
  transport.accept(producer);
  transport.accept(consumer);
  await tick();

  consumer.receive(
    encodeFrame({ lane: "control", family: "relay", seq: 1, payload: { op: "subscribe", stream: "t", from: 0, credit: 100 } }),
  );
  await tick();
  assert.equal(relay.subscriberCount, 1);

  consumer.close(); // hub removes it from the registry on close
  await tick();
  producer.receive(
    encodeFrame({ lane: "bulk", family: "relay", seq: 2, payload: { op: "produce", stream: "t", incarnation: 1, chunk: "x" } }),
  );
  await tick();
  assert.equal(relay.subscriberCount, 0); // pruned lazily on the produce frame

  await hub.close();
});
