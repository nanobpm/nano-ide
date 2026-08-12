/**
 * The family-handler registration seam — S1's canonical extension point.
 *
 * Multiple wave-2 slices (S2 presence/registry, S5 relay, S7 blackboard) each
 * attach a NEW inbound message-family handler to the single hub. To stop them
 * colliding on a central `switch (frame.family)`, the hub's frame→family routing
 * is DERIVED from this registration table: each family is a self-contained
 * module that attaches itself with {@link FamilyRouter.registerFamilyHandler}
 * and the router dispatches by table lookup — never a hand-edited switch.
 *
 * Family keys are the S0 {@link MessageFamily} set (`@nanobpm/agentic-protocol`),
 * the one source of truth; registering a key outside that set is rejected.
 */
import { isMessageFamily } from "../protocol/index.ts";
import type { Frame, MessageFamily } from "../protocol/index.ts";

/**
 * A handler for one message family. `ctx` is whatever per-connection context
 * the hub threads through (see {@link HubConnection}); the router itself is
 * generic so it can be unit-tested without the hub.
 */
export type FamilyHandler<Ctx> = (frame: Frame, ctx: Ctx) => void | Promise<void>;

/** Raised when a family key outside the S0 {@link MessageFamily} set is used. */
export class UnknownFamilyError extends Error {
  readonly family: string;
  constructor(family: string) {
    super(`unknown message family: ${family}`);
    this.name = "UnknownFamilyError";
    this.family = family;
  }
}

/**
 * Raised when a second handler is registered for a family that already has one.
 * One family, one owning module — this guard is what stops two sibling slices
 * silently clobbering each other's handler.
 */
export class DuplicateFamilyHandlerError extends Error {
  readonly family: MessageFamily;
  constructor(family: MessageFamily) {
    super(`a handler is already registered for family: ${family}`);
    this.name = "DuplicateFamilyHandlerError";
    this.family = family;
  }
}

/**
 * The derived frame→family routing table. The hub holds one of these; every
 * family module attaches through {@link registerFamilyHandler}.
 */
export class FamilyRouter<Ctx> {
  readonly #handlers = new Map<MessageFamily, FamilyHandler<Ctx>>();
  #onUnhandled: FamilyHandler<Ctx> | undefined;

  /**
   * Attach the handler that owns `family`. This is the seam every family module
   * calls; it keys off the S0 family set and refuses a duplicate so two slices
   * cannot both claim one family.
   */
  registerFamilyHandler(family: MessageFamily, handler: FamilyHandler<Ctx>): void {
    if (!isMessageFamily(family)) {
      throw new UnknownFamilyError(family);
    }
    if (this.#handlers.has(family)) {
      throw new DuplicateFamilyHandlerError(family);
    }
    this.#handlers.set(family, handler);
  }

  /** Set the fallback invoked for a frame whose family has no handler. */
  onUnhandled(handler: FamilyHandler<Ctx>): void {
    this.#onUnhandled = handler;
  }

  /** Whether a handler is registered for `family`. */
  has(family: MessageFamily): boolean {
    return this.#handlers.has(family);
  }

  /** The families that currently have a handler (the derived table's keys). */
  families(): MessageFamily[] {
    return [...this.#handlers.keys()];
  }

  /**
   * Route one decoded frame to its family handler by table lookup. Returns
   * `true` if a family handler ran, `false` if it fell through to the unhandled
   * fallback (or nowhere). Any handler rejection propagates to the caller.
   */
  async route(frame: Frame, ctx: Ctx): Promise<boolean> {
    const handler = this.#handlers.get(frame.family);
    if (handler === undefined) {
      if (this.#onUnhandled !== undefined) {
        await this.#onUnhandled(frame, ctx);
      }
      return false;
    }
    await handler(frame, ctx);
    return true;
  }
}
