/**
 * Spawn an `opencode acp` (or any ACP-speaking) harness as a subprocess and adapt
 * its stdio to the {@link AcpTransport} port — ADR 0062, slice 2.
 *
 * This is the **only** module in the ACP backend that touches `node:child_process`:
 * the JSON-RPC peer and client speak solely to the transport port, so the whole
 * ingestion stack is exercisable in-memory (see `inMemoryTransportPair`) without a
 * live process. `initialize` still runs against a real `opencode acp` in the
 * env-gated integration test.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type AcpTransport, encodeMessageLine, NewlineJsonDecoder } from "./transport.ts";

export interface SpawnAcpOptions {
  /** The harness executable (e.g. `"opencode"`). */
  readonly command: string;
  /** Its arguments (e.g. `["acp"]`). */
  readonly args?: readonly string[];
  /** Working directory for the harness process. */
  readonly cwd?: string;
  /** Extra environment for the harness (merged over `process.env`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Where to route the harness's stderr diagnostics. Default: inherit. */
  readonly onStderr?: (chunk: string) => void;
}

/** An {@link AcpTransport} bound to a spawned harness, exposing the child handle. */
export interface SpawnedAcpTransport extends AcpTransport {
  /** The underlying child process (for lifecycle assertions / signals). */
  readonly child: ChildProcessWithoutNullStreams;
}

/**
 * Spawn the harness and return a transport over its stdin/stdout with ACP's
 * newline-delimited JSON framing. The child's stderr is protocol-irrelevant
 * (diagnostics only) and is routed to `onStderr` or inherited.
 */
export function spawnAcpTransport(options: SpawnAcpOptions): SpawnedAcpTransport {
  // Omitting `stdio` defaults every stream to "pipe", which is both what ACP's
  // stdio transport needs and what makes the streams statically non-null
  // (ChildProcessWithoutNullStreams). The child's stderr is protocol-irrelevant
  // (diagnostics only) — routed to `onStderr`, or drained to avoid backpressure.
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
  child.stdout.setEncoding("utf8");

  let messageHandler: ((message: unknown) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  const decoder = new NewlineJsonDecoder(
    (message) => messageHandler?.(message),
    (error) => errorHandler?.(error),
  );

  child.stdout.on("data", (chunk: string) => decoder.push(chunk));
  child.on("error", (error) => errorHandler?.(error));
  child.on("exit", (code, signal) => {
    errorHandler?.(new Error(`ACP harness exited (code=${String(code)}, signal=${String(signal)})`));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));

  let closed = false;
  return {
    child,
    send(message: unknown): void {
      if (closed) return;
      child.stdin.write(encodeMessageLine(message));
    },
    onMessage(handler: (message: unknown) => void): void {
      messageHandler = handler;
    },
    onError(handler: (error: Error) => void): void {
      errorHandler = handler;
    },
    close(): void {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill();
    },
  };
}
