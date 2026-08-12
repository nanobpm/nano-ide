/**
 * The blackboard family module — S7's self-contained attachment to the S1 hub.
 *
 * This module owns the `blackboard` message family. It attaches through the hub's
 * canonical {@link AgenticHub.registerFamilyHandler} seam — it does NOT touch a
 * shared frame→family dispatch switch — so it composes with the other family
 * modules (S2 presence, S5 relay) with no shared edit.
 *
 * It promotes nano-workforce's per-plan blackboard HTTP hook to a first-class,
 * capability-scoped channel family. Two operations ride the one `blackboard`
 * family, distinguished by `payload.op`:
 *
 *  - `append` — idempotently write an entry (kinds `file-claim`,
 *    `constraint-change`, `scope-change`, `learning`, `note`). The reply carries
 *    `{ inserted, id, conflicts }`; for a `file-claim`, `conflicts` lists prior
 *    claims by OTHER authors on the same files (first-writer-wins, advisory).
 *  - `read` — return the board's entries after `since` plus the head `cursor`
 *    for incremental polling.
 *
 * The board `scope` is CAPABILITY-DERIVED: by default it is the connection's
 * capability credential (the same credential the S1 handshake gated on — the
 * per-board token nano-workforce's hook already uses as the credential). A
 * connection can therefore only read/write the board its capability authorises,
 * with no board id trusted from the payload. Override {@link BlackboardFamilyOptions.scopeOf}
 * to derive the scope differently (e.g. from an ADR 0028 grant scope).
 *
 * Replies ride the control/facts lane so a blackboard write is never
 * head-of-line-blocked behind a bulk-output storm (invariant 5).
 */
import { validatePayload } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";
import type { AgenticHub, HubConnection } from "@nanobpm/agentic-channel";
import type { BlackboardInput, BlackboardStore, ClaimConflict } from "./store.ts";

export interface BlackboardFamilyOptions {
  /**
   * Resolve the board `scope` for a connection. Default: the capability
   * credential presented at the handshake (`handshake.credential` or the
   * `?capability=` query param) — so each distinct capability is its own board,
   * exactly as nano-workforce's per-plan token is. Return `undefined` to reject
   * the frame (the connection is not scoped to any board).
   */
  scopeOf?: (ctx: HubConnection) => string | undefined;
  /**
   * Notified of a fault this module handles while keeping the connection: a
   * malformed blackboard payload ({@link BlackboardPayloadError}), a missing
   * board scope, or a store error. Other exceptions propagate to {@link AgenticHub}.
   */
  onError?: (err: unknown, connectionId?: string) => void;
}

/** Handle to the attached blackboard family. */
export interface BlackboardFamilyHandle {
  /** Detach is a no-op today; present for symmetry with the other family modules. */
  stop(): void;
}

/** A malformed blackboard payload rejected before it touches the store. */
export class BlackboardPayloadError extends Error {
  constructor(detail: string) {
    super(`invalid blackboard payload: ${detail}`);
    this.name = "BlackboardPayloadError";
  }
}

/** Raised when a connection is not scoped to any board (no capability scope). */
export class BlackboardScopeError extends Error {
  constructor() {
    super("connection is not scoped to any blackboard");
    this.name = "BlackboardScopeError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/** The default scope resolver: the connection's capability credential. */
function defaultScopeOf(ctx: HubConnection): string | undefined {
  const credential = ctx.handshake.credential ?? ctx.handshake.query?.capability;
  const scope = credential?.trim();
  return scope !== undefined && scope !== "" ? scope : undefined;
}

/**
 * Attach the blackboard family (`blackboard`) to `hub`, backed by `store`.
 * Registers one handler via the S1 seam. Returns a handle for symmetry with the
 * other family modules.
 *
 * @throws DuplicateFamilyHandlerError if the `blackboard` family already has a
 *   handler on this hub (one family, one owning module).
 */
export function attachBlackboardFamily(
  hub: AgenticHub,
  store: BlackboardStore,
  options: BlackboardFamilyOptions = {},
): BlackboardFamilyHandle {
  store.ensureSchema();
  const onError = options.onError ?? (() => {});
  const scopeOf = options.scopeOf ?? defaultScopeOf;

  const reject = (connectionId: string, detail: string): void => {
    onError(new BlackboardPayloadError(detail), connectionId);
  };

  hub.registerFamilyHandler("blackboard", (frame: Frame, ctx: HubConnection) => {
    const payload = frame.payload;
    const result = validatePayload("blackboard", payload);
    if (!result.ok) {
      reject(ctx.id, result.errors.map((e) => e.message).join("; "));
      return;
    }
    if (!isPlainObject(payload)) {
      reject(ctx.id, "not an object");
      return;
    }

    const scope = scopeOf(ctx);
    if (scope === undefined) {
      onError(new BlackboardScopeError(), ctx.id);
      return;
    }

    const op = payload.op;
    try {
      if (op === "read") {
        handleRead(store, ctx, frame, scope, payload);
        return;
      }
      // validatePayload already constrained op ∈ {append, read}.
      handleAppend(store, ctx, frame, scope, payload, reject);
    } catch (err) {
      onError(err, ctx.id);
    }
  });

  return {
    stop() {},
  };
}

function handleRead(
  store: BlackboardStore,
  ctx: HubConnection,
  frame: Frame,
  scope: string,
  payload: Record<string, unknown>,
): void {
  const rawSince = payload.since;
  const since = typeof rawSince === "number" ? rawSince : undefined;
  const page = store.readPage(scope, { since });
  ctx.send(reply(frame, { op: "read", scope, cursor: page.cursor, entries: page.entries }));
}

function handleAppend(
  store: BlackboardStore,
  ctx: HubConnection,
  frame: Frame,
  scope: string,
  payload: Record<string, unknown>,
  reject: (connectionId: string, detail: string) => void,
): void {
  const body = readString(payload, "body");
  if (body === undefined || body.trim() === "") {
    reject(ctx.id, "append requires a non-empty body");
    return;
  }
  const files = readStringArray(payload, "files");
  const wave = typeof payload.wave === "number" ? payload.wave : undefined;
  const input: BlackboardInput = {
    authorTask: readString(payload, "authorTask"),
    kind: payload.kind,
    files,
    body,
    wave,
    dedupeKey: readString(payload, "dedupeKey"),
  };
  const { inserted, id } = store.append(scope, input);

  // Conflict-of-intent is reported only for a file-claim carrying files: prior
  // claims by OTHER authors on the same files, decided by insertion order
  // (beforeId = this row's id), exactly as the HTTP hook did.
  let conflicts: ClaimConflict[] = [];
  if (input.kind === "file-claim" && files && files.length > 0) {
    conflicts = store.detectFileClaimConflicts(scope, { authorTask: input.authorTask, files, beforeId: id });
  }
  ctx.send(reply(frame, { op: "append", scope, inserted, id, conflicts }));
}

/** Build a control-lane blackboard reply that echoes the request `seq` for correlation. */
function reply(request: Frame, payload: unknown): Frame {
  return { lane: "control", family: "blackboard", seq: request.seq, payload };
}
