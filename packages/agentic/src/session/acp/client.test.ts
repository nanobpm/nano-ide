import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivationKey } from "../adapter.ts";
import { openInMemorySession } from "../backend.ts";
import type { SessionEvent } from "../events.ts";
import { AcpSessionClient, type SessionEventSink } from "./client.ts";
import { startFakeAcpAgent } from "./fake-agent.ts";
import { AcpConnection } from "./jsonrpc.ts";
import { inMemoryTransportPair } from "./transport.ts";

const KEY: ActivationKey = { processInstanceKey: "pik-1", elementId: "implement-task" };
const CWD = "/work/repo";

function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

function collector(): { sink: SessionEventSink; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return { events, sink: { emit: (event) => events.push(event) } };
}

function connectClient(
  script: Parameters<typeof startFakeAcpAgent>[1],
  sink: SessionEventSink,
): { client: AcpSessionClient; closeAgent: () => void } {
  const { client: clientTransport, agent: agentTransport } = inMemoryTransportPair();
  const agent = startFakeAcpAgent(agentTransport, script);
  const client = new AcpSessionClient(new AcpConnection(clientTransport), sink, { newEventId: seqIds("e") });
  return { client, closeAgent: () => agent.close() };
}

function connectClientWithAgent(
  script: Parameters<typeof startFakeAcpAgent>[1],
  sink: SessionEventSink,
): { client: AcpSessionClient; agent: AcpConnection; closeAgent: () => void } {
  const { client: clientTransport, agent: agentTransport } = inMemoryTransportPair();
  const agent = startFakeAcpAgent(agentTransport, script);
  const client = new AcpSessionClient(new AcpConnection(clientTransport), sink, { newEventId: seqIds("e") });
  return { client, agent, closeAgent: () => agent.close() };
}

test("initialize surfaces durable-resume:true when the agent advertises loadSession", async () => {
  const { sink } = collector();
  const { client } = connectClient({ loadSession: true }, sink);
  const probe = await client.initialize();
  assert.equal(probe.loadSession, true);
  assert.equal(probe.durableResume, true);
  assert.equal(probe.protocolVersion, 1);
});

test("initialize surfaces durable-resume:false when the agent lacks loadSession", async () => {
  const { sink } = collector();
  const { client } = connectClient({ loadSession: false }, sink);
  const probe = await client.initialize();
  assert.equal(probe.loadSession, false);
  assert.equal(probe.durableResume, false);
});

test("a driven session normalises the update stream into canonical events on the authoritative log", async () => {
  const { backend, log } = openInMemorySession(KEY, 1);
  const { client: clientTransport, agent: agentTransport } = inMemoryTransportPair();
  startFakeAcpAgent(agentTransport, {
    loadSession: true,
    promptUpdates: [
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } },
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "grep", status: "pending", rawInput: { q: "foo" } },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { hits: 3 } },
      { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done" } },
    ],
    promptStopReason: "end_turn",
  });
  const client = new AcpSessionClient(new AcpConnection(clientTransport), backend, { newEventId: seqIds("e") });

  await client.initialize();
  await client.newSession({ cwd: CWD });
  const result = await client.prompt("please search");

  assert.equal(result.stopReason, "end_turn");
  const logged = log.replay(KEY, 0);
  assert.deepEqual(
    logged.map((e) => ({ type: e.type, offset: e.offset })),
    [
      { type: "assistant", offset: 0 },
      { type: "tool-call", offset: 1 },
      { type: "tool-result", offset: 2 },
      { type: "assistant", offset: 3 },
    ],
    "chunks coalesce into whole messages; the tool lifecycle becomes tool-call + tool-result",
  );

  const [assistant, toolCall, toolResult, done] = logged;
  assert.equal(assistant.type === "assistant" && assistant.text, "Hello world");
  assert.equal(toolCall.type === "tool-call" && toolCall.name, "grep");
  assert.deepEqual(toolCall.type === "tool-call" ? toolCall.args : null, { q: "foo" });
  assert.equal(toolResult.type === "tool-result" && toolResult.ok, true);
  assert.deepEqual(toolResult.type === "tool-result" ? toolResult.result : null, { hits: 3 });
  assert.equal(done.type === "assistant" && done.text, "Done");

  // The producer owns a single unbroken causal chain across the whole stream.
  assert.equal(assistant.parentId, null);
  assert.equal(toolCall.parentId, assistant.id);
  assert.equal(toolResult.parentId, toolCall.id);
  assert.equal(done.parentId, toolResult.id);
});

test("restore replays prior history via session/load, then the agent continues", async () => {
  const { backend, log } = openInMemorySession(KEY, 1);
  const { client: clientTransport, agent: agentTransport } = inMemoryTransportPair();
  startFakeAcpAgent(agentTransport, {
    loadSession: true,
    loadUpdates: [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "prior question" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "prior answer" } },
    ],
    promptUpdates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } }],
  });
  const client = new AcpSessionClient(new AcpConnection(clientTransport), backend, { newEventId: seqIds("e") });

  const probe = await client.initialize();
  assert.equal(probe.durableResume, true);

  const restored = await client.restore("sess-existing", { cwd: CWD });
  assert.deepEqual(
    restored.map((e) => e.type),
    ["user", "assistant"],
    "session/load replays the prior turn as normalised events",
  );
  assert.equal(client.sessionId, "sess-existing");

  await client.prompt("carry on");
  const logged = log.replay(KEY, 0);
  assert.deepEqual(logged.map((e) => e.type), ["user", "assistant", "assistant"]);
  const last = logged[2];
  assert.equal(last.type === "assistant" && last.text, "continued");
  // The resumed turn continues the same causal chain as the restored history.
  assert.equal(last.parentId, logged[1].id);
});

test("consecutive same-message chunks coalesce; a new messageId starts a new event", async () => {
  const { sink, events } = collector();
  const { client: clientTransport, agent: agentTransport } = inMemoryTransportPair();
  startFakeAcpAgent(agentTransport, {
    promptUpdates: [
      { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "one " } },
      { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "two" } },
      { sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "three" } },
    ],
  });
  const client = new AcpSessionClient(new AcpConnection(clientTransport), sink, { newEventId: seqIds("e") });
  await client.initialize();
  await client.newSession({ cwd: CWD });
  await client.prompt("go");

  assert.deepEqual(
    events.map((e) => (e.type === "assistant" ? e.text : e.type)),
    ["one two", "three"],
  );
});

test("session/update addressed to a different session id is ignored", async () => {
  const { sink, events } = collector();
  const { client, agent } = connectClientWithAgent(
    {
      sessionId: "sess-mine",
      promptUpdates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } }],
      promptStopReason: "end_turn",
    },
    sink,
  );
  await client.initialize();
  await client.newSession({ cwd: CWD });
  // A stray update for a *different* session must not enter this session's stream.
  agent.notify("session/update", {
    sessionId: "sess-other",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } },
  });
  await client.prompt("hi");

  assert.deepEqual(
    events.map((e) => (e.type === "assistant" ? e.text : e.type)),
    ["mine"],
    "only the update addressed to sess-mine is ingested; the sess-other leak is dropped",
  );
});

test("prompt before a session is established throws", async () => {
  const { sink } = collector();
  const { client } = connectClient({}, sink);
  await client.initialize();
  await assert.rejects(() => client.prompt("hi"), /active session/);
});

test("default permission handler selects the allow-flavoured option", async () => {
  const { sink } = collector();
  const { client, agent } = connectClientWithAgent({}, sink);
  await client.initialize();
  const outcome = await agent.request("session/request_permission", {
    options: [
      { optionId: "reject", kind: "reject_once" },
      { optionId: "ok", kind: "allow_once" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "ok" } });
});

test("default permission handler cancels when no allow-flavoured option is offered", async () => {
  const { sink } = collector();
  const { client, agent } = connectClientWithAgent({}, sink);
  await client.initialize();
  // No option's kind starts with "allow" — the handler must cancel, not select the
  // first (possibly deny) option by ordering.
  const outcome = await agent.request("session/request_permission", {
    options: [
      { optionId: "reject", kind: "reject_once" },
      { optionId: "reject-all", kind: "reject_always" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "cancelled" } });
});
