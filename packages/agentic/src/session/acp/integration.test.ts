/**
 * Integration test against a *real* ACP harness — ADR 0062, slice 2 acceptance.
 *
 * Skipped by default: it only runs when `ACP_OPENCODE_CMD` names a real
 * ACP-speaking binary (e.g. `ACP_OPENCODE_CMD=opencode ACP_OPENCODE_ARGS=acp`),
 * so CI stays hermetic while the acceptance path ("against a real `opencode acp`
 * process: `initialize` reports `loadSession`") remains exercisable on demand.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpSessionClient } from "./client.ts";
import { AcpConnection } from "./jsonrpc.ts";
import { spawnAcpTransport } from "./spawn.ts";

const command = process.env.ACP_OPENCODE_CMD;
const args = process.env.ACP_OPENCODE_ARGS
  ? process.env.ACP_OPENCODE_ARGS.trim().split(/\s+/).filter(Boolean)
  : ["acp"];

test(
  "initialize against a real ACP harness reports its loadSession capability",
  { skip: command ? false : "set ACP_OPENCODE_CMD to run the real-harness integration test" },
  async () => {
    assert.ok(command);
    const transport = spawnAcpTransport({ command, args, cwd: process.cwd() });
    const client = new AcpSessionClient(new AcpConnection(transport), { emit: () => {} });
    try {
      const probe = await client.initialize();
      assert.equal(typeof probe.loadSession, "boolean");
      assert.equal(probe.durableResume, probe.loadSession);
      assert.ok(Number.isInteger(probe.protocolVersion));
    } finally {
      client.close();
      transport.close();
    }
  },
);
