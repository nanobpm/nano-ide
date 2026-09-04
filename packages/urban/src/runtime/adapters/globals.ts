import { isRecord } from "../core/guards.ts";

export interface DenoRuntimeGlobal {
  version?: unknown;
  stdin?: { readable?: ReadableStream<Uint8Array> };
  args?: string[];
  exit?: (code: number) => void;
  addSignalListener?: (sig: string, cb: () => void) => void;
}

/**
 * The subset of a Node writable stdio stream (`process.stdout` / `process.stderr`) we depend on:
 * a `write` that accepts a completion callback fired once the chunk has flushed to the OS. Deno's
 * stdio streams do not expose this shape; callers treat its absence as "already synchronous, no
 * flush needed" (see `flushStdio` in cli.ts).
 */
export interface WritableStdio {
  write?: (chunk: string, cb: () => void) => void;
}

export interface ProcessRuntimeGlobal {
  argv?: string[];
  exit?: (code: number) => void;
  stdin?: AsyncIterable<Uint8Array | string> & { setEncoding?(encoding: string): void };
  stdout?: WritableStdio;
  stderr?: WritableStdio;
  on?: (sig: string, cb: () => void) => void;
}

export function denoGlobal(): DenoRuntimeGlobal | undefined {
  const value: unknown = Reflect.get(globalThis, "Deno");
  return isRecord(value) ? value : undefined;
}

export function processGlobal(): ProcessRuntimeGlobal | undefined {
  const value: unknown = Reflect.get(globalThis, "process");
  return isRecord(value) ? value : undefined;
}

