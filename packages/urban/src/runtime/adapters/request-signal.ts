/**
 * Scope an upstream abort signal to the lifetime of one handler invocation (issue #633).
 *
 * `HttpRequest.signal` promises to abort only on client disconnect *before* the response
 * completes. Some runtimes (Deno's default legacy abort mode) also abort `request.signal`
 * after a successful response, so forwarding it raw would fire cancellation callbacks after
 * normal completion. This returns a derived signal that mirrors `source` only until `settle()`
 * is called; aborts after that are ignored and the upstream listener is removed.
 */
export function scopedRequestSignal(source: AbortSignal): { signal: AbortSignal; settle: () => void } {
  const controller = new AbortController();
  if (source.aborted) {
    controller.abort(source.reason);
    return { signal: controller.signal, settle: () => {} };
  }
  const onAbort = (): void => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    settle: () => source.removeEventListener("abort", onAbort),
  };
}
