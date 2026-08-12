/**
 * The presence family module — S2's self-contained attachment to the S1 hub.
 *
 * This module owns the `register`, `heartbeat` and `deregister` message
 * families. It attaches through the hub's canonical
 * {@link AgenticHub.registerFamilyHandler} seam — it does NOT touch a shared
 * frame→family dispatch switch — so it composes with the other wave-2 family
 * modules (S5 relay, S7 blackboard) with no shared edit.
 *
 * On `register` it writes a durable presence row (via {@link PresenceStore}) and
 * mirrors instance+capability onto S1's in-memory connection registry
 * (`ctx.registry.setPresence`). `heartbeat` refreshes the row's liveness;
 * `deregister` removes it. Rows the fleet stops heartbeating age out on the
 * presence TTL via the sweep this module schedules.
 */
import { validatePayload } from "@nanobpm/agentic-protocol";
import type { Capability, Frame } from "@nanobpm/agentic-protocol";
import type { AgenticHub, HubConnection } from "@nanobpm/agentic-channel";
import type { PresenceRow, PresenceStore } from "./store.ts";

export interface PresenceFamilyOptions {
  /**
   * How often to age out stale presence rows, in ms. Default: a third of the
   * store's TTL. Pass 0 to disable the internal timer (tests call
   * {@link PresenceFamilyHandle.sweepNow} explicitly). The sweep reads "now"
   * from the store's own clock, so liveness time has a single source of truth.
   */
  sweepIntervalMs?: number;
  /** Notified of a malformed frame or handler fault; the connection is kept. */
  onError?: (err: unknown, connectionId?: string) => void;
}

/** Handle to the attached presence family — drives/stops the presence sweep. */
export interface PresenceFamilyHandle {
  /** Age out stale presence rows now and return the removed rows. */
  sweepNow(): PresenceRow[];
  /** Stop the presence sweep timer. */
  stop(): void;
}

/** A malformed presence payload rejected before it touches the store. */
export class PresencePayloadError extends Error {
  readonly family: string;
  constructor(family: string, detail: string) {
    super(`invalid ${family} payload: ${detail}`);
    this.name = "PresencePayloadError";
    this.family = family;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/** Extract the enrolment capability from a validated `register` payload. */
function readCapability(record: Record<string, unknown>): Capability {
  const raw = record.capability;
  if (!isPlainObject(raw)) return {};
  const cap: { cognition?: string; weight?: number; family?: string; host?: string } = {};
  const cognition = readString(raw, "cognition");
  if (cognition !== undefined) cap.cognition = cognition;
  const weight = readNumber(raw, "weight");
  if (weight !== undefined) cap.weight = weight;
  const family = readString(raw, "family");
  if (family !== undefined) cap.family = family;
  const host = readString(raw, "host");
  if (host !== undefined) cap.host = host;
  return cap;
}

/**
 * Attach the presence family (`register`/`heartbeat`/`deregister`) to `hub`,
 * backed by `store`. Registers three handlers via the S1 seam and schedules the
 * presence-TTL sweep. Returns a handle to drive/stop the sweep.
 *
 * @throws DuplicateFamilyHandlerError if one of the three families already has
 *   a handler on this hub (one family, one owning module).
 */
export function attachPresenceFamily(
  hub: AgenticHub,
  store: PresenceStore,
  options: PresenceFamilyOptions = {},
): PresenceFamilyHandle {
  store.ensureSchema();
  const onError = options.onError ?? (() => {});

  const reject = (family: string, connectionId: string, detail: string): void => {
    onError(new PresencePayloadError(family, detail), connectionId);
  };

  hub.registerFamilyHandler("register", (frame: Frame, ctx: HubConnection) => {
    const payload = frame.payload;
    const result = validatePayload("register", payload);
    if (!result.ok || !isPlainObject(payload)) {
      reject("register", ctx.id, result.ok ? "not an object" : result.errors.map((e) => e.message).join("; "));
      return;
    }
    const instance = readString(payload, "instance");
    if (instance === undefined) {
      reject("register", ctx.id, "missing instance");
      return;
    }
    const capability = readCapability(payload);
    store.register({ instance, connectionId: ctx.id, identity: ctx.identity, capability });
    // Mirror the enrolment onto S1's in-memory connection registry so a live
    // connection carries its instance+capability without a DB read.
    ctx.registry.setPresence(ctx.id, { instance, capability });
  });

  hub.registerFamilyHandler("heartbeat", (frame: Frame, ctx: HubConnection) => {
    const payload = frame.payload;
    const result = validatePayload("heartbeat", payload);
    if (!result.ok || !isPlainObject(payload)) {
      reject("heartbeat", ctx.id, result.ok ? "not an object" : result.errors.map((e) => e.message).join("; "));
      return;
    }
    const instance = readString(payload, "instance");
    if (instance === undefined) {
      reject("heartbeat", ctx.id, "missing instance");
      return;
    }
    store.heartbeat(instance);
  });

  hub.registerFamilyHandler("deregister", (frame: Frame, ctx: HubConnection) => {
    const payload = frame.payload;
    const result = validatePayload("deregister", payload);
    if (!result.ok || !isPlainObject(payload)) {
      reject("deregister", ctx.id, result.ok ? "not an object" : result.errors.map((e) => e.message).join("; "));
      return;
    }
    const instance = readString(payload, "instance");
    if (instance === undefined) {
      reject("deregister", ctx.id, "missing instance");
      return;
    }
    store.deregister(instance);
  });

  const sweepNow = (): PresenceRow[] => {
    try {
      return store.sweep();
    } catch (err) {
      onError(err);
      return [];
    }
  };

  const interval = options.sweepIntervalMs ?? Math.max(1, Math.floor(store.ttlMs / 3));
  let timer: ReturnType<typeof setInterval> | undefined;
  if (interval > 0) {
    timer = setInterval(sweepNow, interval);
    // Do not keep the process alive solely for the presence sweep.
    timer.unref?.();
  }

  return {
    sweepNow,
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
