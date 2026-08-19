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
  /** Where to route the harness's stderr diagnostics. Default: drained and discarded. */
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
 * (diagnostics only): it is always piped and routed to `onStderr` when provided,
 * otherwise drained and discarded (never inherited by the parent's stderr).
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
  let closed = false;
  const decoder = new NewlineJsonDecoder(
    (message) => messageHandler?.(message),
    (error) => errorHandler?.(error),
  );

  child.stdout.on("data", (chunk: string) => decoder.push(chunk));
  // On EOF, flush any final message the harness wrote without a trailing newline
  // rather than dropping it.
  child.stdout.on("end", () => decoder.flush());
  child.on("error", (error) => errorHandler?.(error));
  child.on("exit", (code, signal) => {
    // A caller-initiated close() kills the child and triggers this exit; that is a
    // normal shutdown, not a transport error, so do not surface a spurious error.
    if (closed) return;
    errorHandler?.(new Error(`ACP harness exited (code=${String(code)}, signal=${String(signal)})`));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));

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
