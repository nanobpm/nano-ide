/**
 * Unit tests for {@link spawnAcpTransport}. These spawn the test runtime's own
 * `node` (never an external ACP binary), so they stay hermetic and deterministic —
 * the env-gated real-harness path lives in `integration.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnAcpTransport } from "./spawn.ts";

/** A short-lived `node` invocation running the given script. */
function nodeScript(script: string) {
  return spawnAcpTransport({ command: process.execPath, args: ["-e", script] });
}

test("close() suppresses the child's exit as a transport error (normal shutdown, not a fault)", async () => {
  const errors: Error[] = [];
  // Stay alive until stdin closes, so the only thing that ends this child is our close().
  const transport = nodeScript("process.stdin.resume()");
  transport.onError((error) => errors.push(error));
  const exited = new Promise<void>((resolve) => transport.child.on("exit", () => resolve()));

  transport.close();
  await exited;
  // Give any queued exit handler a turn to run.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, [], "a caller-initiated close() must not surface a spurious exit error");
});

test("a final message written without a trailing newline is flushed at EOF, not dropped", async () => {
  const messages: unknown[] = [];
  // Write one complete JSON message with NO trailing newline, then exit.
  const transport = nodeScript('process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "hello" }))');
  transport.onError(() => {});
  const received = new Promise<void>((resolve) => {
    transport.onMessage((m) => {
      messages.push(m);
      resolve();
    });
  });

  await received;
  assert.deepEqual(messages, [{ jsonrpc: "2.0", method: "hello" }], "the unterminated final line is flushed on EOF");
  transport.close();
});
