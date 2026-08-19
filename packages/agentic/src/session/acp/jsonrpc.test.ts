import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpConnection, AcpRpcError } from "./jsonrpc.ts";
import { inMemoryTransportPair } from "./transport.ts";

test("a request resolves with the peer's result", async () => {
  const { client, agent } = inMemoryTransportPair();
  const clientConn = new AcpConnection(client);
  const agentConn = new AcpConnection(agent);
  agentConn.onRequest("ping", (params) => ({ echoed: params }));

  const result = await clientConn.request("ping", { n: 1 });
  assert.deepEqual(result, { echoed: { n: 1 } });
});

test("a request rejects with an AcpRpcError when the peer returns an error", async () => {
  const { client, agent } = inMemoryTransportPair();
  const clientConn = new AcpConnection(client);
  const agentConn = new AcpConnection(agent);
  agentConn.onRequest("boom", () => {
    throw new AcpRpcError(-32000, "kaboom", { extra: true });
  });

  await assert.rejects(
    () => clientConn.request("boom"),
    (error: unknown) => {
      assert.ok(error instanceof AcpRpcError);
      assert.equal(error.code, -32000);
      assert.equal(error.message, "kaboom");
      assert.deepEqual(error.data, { extra: true });
      return true;
    },
  );
});

test("an unhandled inbound request is answered with method-not-found", async () => {
  const { client, agent } = inMemoryTransportPair();
  const clientConn = new AcpConnection(client);
  // The agent side registers no handler for "unknown/method".
  new AcpConnection(agent);

  await assert.rejects(
    () => clientConn.request("unknown/method"),
    (error: unknown) => {
      assert.ok(error instanceof AcpRpcError);
      assert.equal(error.code, -32601);
      return true;
    },
  );
});

test("notifications are dispatched to the registered handler and expect no response", async () => {
  const { client, agent } = inMemoryTransportPair();
  const clientConn = new AcpConnection(client);
  const agentConn = new AcpConnection(agent);
  const received: unknown[] = [];
  agentConn.onNotification("event", (params) => received.push(params));

  clientConn.notify("event", { tick: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(received, [{ tick: 1 }]);
});

test("closing a connection rejects every in-flight request", async () => {
  const { client, agent } = inMemoryTransportPair();
  const clientConn = new AcpConnection(client);
  const agentConn = new AcpConnection(agent);
  // A handler that never resolves, so the request stays in flight until close.
  agentConn.onRequest("hang", () => new Promise(() => {}));

  const pending = clientConn.request("hang");
  clientConn.close();
  await assert.rejects(() => pending, /closed/);
});
