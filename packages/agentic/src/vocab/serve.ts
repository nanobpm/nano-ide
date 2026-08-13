/**
 * The REGISTER→SERVE handshake mechanics.
 *
 * S2 owns the `register` family on the hub (one family, one owning module — this
 * slice does NOT claim it). S3 supplies the other half of the handshake: given a
 * declared enrolment capability, resolve it (via {@link VocabResolver}) to its
 * SERVE token set and emit a `serve` frame back to the worker.
 *
 * The `serve` reply rides the CONTROL lane — it is a control/facts message, so a
 * bulk relay storm can never delay a worker learning which tokens it may serve
 * (S0 invariant 5). The composition root wires this after presence register
 * (e.g. from S2's register path or an app-level adapter); keeping it a pure,
 * connection-agnostic helper is what lets it compose without editing S2.
 */
import type { Capability, Frame, ServePayload } from "../protocol/index.ts";
import { MAX_SEQ, validatePayload } from "../protocol/index.ts";
import type { Resolution, VocabResolver } from "./resolver.ts";

/** The minimal per-connection sink a serve reply needs — S1's `HubConnection.send`. */
export interface ServeSink {
  send(frame: Frame): void;
}

/** Build the `serve` payload for an instance and its resolved token set. */
export function buildServePayload(instance: string, tokens: readonly string[]): ServePayload {
  return { instance, tokens: [...tokens] };
}

/**
 * Build the `serve` frame carrying an instance's SERVE token set. Rides the
 * control lane; `seq` defaults to 0 (the caller owns per-connection sequencing).
 * The built payload is validated against the S0 `serve` contract, so a
 * malformed token set fails loudly here rather than on the wire. `seq` is
 * likewise checked against the wire's uint32 bound (the same {@link MAX_SEQ}
 * `encodeFrame` enforces) so a bad sequence number fails here — at construction
 * — rather than later during encoding.
 */
export function buildServeFrame(instance: string, tokens: readonly string[], seq = 0): Frame {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
    throw new Error(`refusing to build serve frame with invalid seq (must be a uint32): ${String(seq)}`);
  }
  const payload = buildServePayload(instance, tokens);
  const check = validatePayload("serve", payload);
  if (!check.ok) {
    throw new Error(`refusing to build invalid serve frame: ${check.errors.map((e) => e.message).join("; ")}`);
  }
  return { lane: "control", family: "serve", seq, payload };
}

/**
 * Resolve `capability` and send the resulting `serve` frame to `sink`. Returns
 * the {@link Resolution} so the caller can also record the assigned tokens (e.g.
 * for demand×supply or diversity correlation). This is the server side of
 * `REGISTER {capability}` → `SERVE [leaf tokens]`.
 */
export function serveCapability(
  resolver: VocabResolver,
  sink: ServeSink,
  instance: string,
  capability: Capability,
  seq = 0,
): Resolution {
  const resolution = resolver.resolve(capability);
  sink.send(buildServeFrame(instance, resolution.tokens, seq));
  return resolution;
}
