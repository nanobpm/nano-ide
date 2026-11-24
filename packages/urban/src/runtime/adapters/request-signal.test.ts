import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedRequestSignal } from "./request-signal.ts";

test("scopedRequestSignal aborts when the source aborts before settle (client disconnect)", () => {
  const src = new AbortController();
  const { signal } = scopedRequestSignal(src.signal);
  src.abort();
  assert.equal(signal.aborted, true);
});

test("scopedRequestSignal ignores a source abort after settle (Deno legacy post-response abort)", () => {
  const src = new AbortController();
  const { signal, settle } = scopedRequestSignal(src.signal);
  let fired = 0;
  signal.addEventListener("abort", () => fired++);
  settle();
  src.abort();
  assert.equal(signal.aborted, false);
  assert.equal(fired, 0);
});

test("scopedRequestSignal propagates an already-aborted source", () => {
  const src = new AbortController();
  src.abort();
  assert.equal(scopedRequestSignal(src.signal).signal.aborted, true);
});
