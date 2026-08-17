// events — the Urban extension-event microkernel: a tiny, defensive, typed event
// bus whose extension points are *typed channels* with a **deliberate dispatch
// mode**. Cribbed from the DeepSeek Harness Cordis microkernel taxonomy (issue
// #262): instead of wiring modules directly into `runtime.ts`, a seam is a named
// channel, and *how* its listeners run is a property of the channel, not of each
// call site.
//
// Four dispatch modes, each for a different kind of seam:
//
//   - **waterfall** (around-middleware): a listener wraps `next`, so it can
//     transform the value, short-circuit (never call `next`), recover (catch a
//     downstream throw), or wrap the result. For policy / permission / transform
//     seams.
//   - **serial**: listeners awaited in registration order — for ordered
//     checkpoints (e.g. extension registration).
//   - **parallel**: listeners awaited as a fan-out — every listener gets an
//     *independent* chance to run (one throw never denies another its turn).
//   - **emit**: synchronous fire-and-forget — for notifications (lifecycle,
//     errors, observations).
//
// Two contracts make this HMR- and disposal-friendly (the payoff the issue steals
// from `cordis`):
//
//   1. **Defensive dispatch.** A listener exception is *contained* at the pipeline
//      boundary: the bus warns via `onError` and the pipeline continues — a
//      throwing extension never strands app boot or a request.
//   2. **Dispose ladder.** Every registration is an *effect*: `on()` returns a
//      `Disposer` AND is pushed onto the bus's ladder. `bus.dispose()` unwinds the
//      whole ladder LIFO, so a `start → stop → start` cycle (or a dev-server HMR
//      reload) leaks no listeners.
//
// This file is runtime-agnostic (core purity): it takes an injected `onError`
// sink so the host's structured logger, not `console`, reports contained throws.

/** Disposes a single registration (idempotent — safe to call more than once). */
export type Disposer = () => void;

/** The deliberate dispatch semantics a channel declares. */
export type DispatchMode = "waterfall" | "serial" | "parallel" | "emit";

/** A waterfall listener: around-middleware over `next`. Call `next(value)` to
 *  continue the chain (optionally transforming `value` first), return without
 *  calling it to short-circuit, or wrap `next(...)` in try/catch to recover. */
export type Middleware<T, R> = (value: T, next: (value: T) => Promise<R>) => R | Promise<R>;

/** A serial/parallel/emit listener: observes (and may act on) the payload. Typed
 *  to return `void` (the DOM/Node listener convention): the void-return position
 *  lets both an `async` handler (its `Promise<void>` is awaited by serial/parallel
 *  dispatch) and a value-returning one-liner register without friction. */
export type Listener<T> = (payload: T) => void;

/** Where contained listener throws are reported. */
export type ErrorSink = (err: unknown, info: { event: string; mode: DispatchMode }) => void;

export interface EventBusOptions {
  /** Reports a contained listener throw. Defaults to `console.warn`. The runtime
   *  injects `host.log("warn", …)` so contained throws land in structured logs. */
  onError?: ErrorSink;
}

const defaultErrorSink: ErrorSink = (err, info) => {
  console.warn(`[urban events] listener for "${info.event}" (${info.mode}) threw and was contained`, err);
};

/** An ordered set of listeners plus the ladder bookkeeping shared by channels. A
 *  channel owns one of these; the bus owns the global dispose ladder that every
 *  channel pushes its per-listener disposers onto. */
class ChannelBase<F> {
  protected readonly listeners = new Set<F>();
  readonly event: string;
  readonly mode: DispatchMode;
  private readonly ladder: Set<Disposer>;
  protected readonly onError: ErrorSink;

  constructor(event: string, mode: DispatchMode, ladder: Set<Disposer>, onError: ErrorSink) {
    this.event = event;
    this.mode = mode;
    this.ladder = ladder;
    this.onError = onError;
  }

  /** Register `listener` as an effect: it joins this channel AND the bus dispose
   *  ladder. The returned disposer removes it from both and is idempotent. */
  protected register(listener: F): Disposer {
    this.listeners.add(listener);
    let disposed = false;
    const dispose: Disposer = () => {
      if (disposed) return;
      disposed = true;
      this.listeners.delete(listener);
      this.ladder.delete(dispose);
    };
    this.ladder.add(dispose);
    return dispose;
  }

  /** Contain a listener throw at the pipeline boundary. */
  protected contain(err: unknown): void {
    try {
      this.onError(err, { event: this.event, mode: this.mode });
    } catch {
      // The error sink itself must never strand the pipeline.
    }
  }

  /** How many listeners are currently registered (for leak assertions). */
  get size(): number {
    return this.listeners.size;
  }
}

/** **emit** — synchronous fire-and-forget notifications. */
export class EmitChannel<T> extends ChannelBase<Listener<T>> {
  on(listener: Listener<T>): Disposer {
    return this.register(listener);
  }

  /** Notify every listener synchronously; a throw is contained, the rest still
   *  run. A listener may return a promise, but `emit` does not await it. */
  emit(payload: T): void {
    for (const listener of this.listeners) {
      try {
        void listener(payload);
      } catch (err) {
        this.contain(err);
      }
    }
  }
}

/** **serial** — listeners awaited in registration order (ordered checkpoint). */
export class SerialChannel<T> extends ChannelBase<Listener<T>> {
  on(listener: Listener<T>): Disposer {
    return this.register(listener);
  }

  /** Run every listener in order, awaiting each. A throw is contained and the
   *  next listener still runs — one failing checkpoint never strands the rest. */
  async run(payload: T): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(payload);
      } catch (err) {
        this.contain(err);
      }
    }
  }
}

/** **parallel** — fan-out where every listener gets an independent chance. */
export class ParallelChannel<T> extends ChannelBase<Listener<T>> {
  on(listener: Listener<T>): Disposer {
    return this.register(listener);
  }

  /** Run every listener concurrently and await them all. Each is independently
   *  contained, so one throw never denies another listener its turn (cf. the
   *  `session/flush` durability checkpoint). */
  async run(payload: T): Promise<void> {
    await Promise.all(
      [...this.listeners].map(async (listener) => {
        try {
          await listener(payload);
        } catch (err) {
          this.contain(err);
        }
      }),
    );
  }
}

/** **waterfall** — around-middleware chain (transform / short-circuit / recover). */
export class WaterfallChannel<T, R> extends ChannelBase<Middleware<T, R>> {
  on(middleware: Middleware<T, R>): Disposer {
    return this.register(middleware);
  }

  /** Compose the middlewares around `base`, outermost-first in registration
   *  order. A middleware that never calls `next` short-circuits the chain; one
   *  that throws *without* producing a result is contained and delegated past
   *  (the chain continues with the unchanged value) so it never strands the
   *  pipeline. */
  async run(seed: T, base: (value: T) => R | Promise<R>): Promise<R> {
    const middlewares = [...this.listeners];
    const dispatch = async (index: number, value: T): Promise<R> => {
      if (index >= middlewares.length) return base(value);
      const middleware = middlewares[index];
      let advanced: Promise<R> | undefined;
      const next = (forwarded: T): Promise<R> => {
        advanced = dispatch(index + 1, forwarded);
        return advanced;
      };
      try {
        return await middleware(value, next);
      } catch (err) {
        this.contain(err);
        // Delegate: honor the downstream result if the middleware already
        // advanced the chain, else continue past it with the unchanged value.
        return advanced !== undefined ? advanced : dispatch(index + 1, value);
      }
    };
    return dispatch(0, seed);
  }
}

/** The microkernel: a factory of typed channels sharing one dispose ladder. Each
 *  channel is created directly (and typed at its call site), so the bus never has
 *  to store — or cast back — a heterogeneous channel collection. Declare each seam
 *  exactly once and hold the returned typed reference (see the Urban taxonomy in
 *  `extensions.ts`); the bus guards against a name being declared twice under a
 *  different mode. */
export class EventBus {
  private readonly ladder = new Set<Disposer>();
  private readonly declared = new Map<string, DispatchMode>();
  private readonly onError: ErrorSink;

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError ?? defaultErrorSink;
  }

  private reserve(event: string, mode: DispatchMode): void {
    const existing = this.declared.get(event);
    if (existing !== undefined) {
      throw new Error(
        existing === mode
          ? `event "${event}" already declared; hold the channel returned by the first declaration`
          : `event "${event}" already declared as "${existing}"; cannot redeclare as "${mode}"`,
      );
    }
    this.declared.set(event, mode);
  }

  /** Declare an **emit** channel. */
  emit<T>(event: string): EmitChannel<T> {
    this.reserve(event, "emit");
    return new EmitChannel<T>(event, "emit", this.ladder, this.onError);
  }

  /** Declare a **serial** channel. */
  serial<T>(event: string): SerialChannel<T> {
    this.reserve(event, "serial");
    return new SerialChannel<T>(event, "serial", this.ladder, this.onError);
  }

  /** Declare a **parallel** channel. */
  parallel<T>(event: string): ParallelChannel<T> {
    this.reserve(event, "parallel");
    return new ParallelChannel<T>(event, "parallel", this.ladder, this.onError);
  }

  /** Declare a **waterfall** channel. */
  waterfall<T, R>(event: string): WaterfallChannel<T, R> {
    this.reserve(event, "waterfall");
    return new WaterfallChannel<T, R>(event, "waterfall", this.ladder, this.onError);
  }

  /** Register an arbitrary disposable effect (a timer, a subscription, a
   *  registration made elsewhere) directly onto the dispose ladder, so
   *  `dispose()` unwinds it with everything else — the dispose-ladder contract is
   *  not limited to channel listeners. Returns an idempotent disposer that detaches
   *  it (and runs the cleanup) early; a throw from the cleanup is contained. */
  effect(dispose: Disposer): Disposer {
    let disposed = false;
    const entry: Disposer = () => {
      if (disposed) return;
      disposed = true;
      this.ladder.delete(entry);
      try {
        dispose();
      } catch (err) {
        this.contain(err);
      }
    };
    this.ladder.add(entry);
    return entry;
  }

  /** Total live registrations on the dispose ladder — every channel listener AND
   *  every `effect()` (arbitrary disposable), not only channel listeners. This is
   *  the leak-assertion metric: it reads 0 exactly when the ladder is fully
   *  unwound. */
  get listenerCount(): number {
    return this.ladder.size;
  }

  /** Unwind the whole dispose ladder LIFO: every registration made through this
   *  bus is torn down. Contained end-to-end, so one bad disposer can't strand the
   *  rest. Idempotent — a second call is a no-op. This is what makes a
   *  `start → stop → start` cycle (and dev-server HMR) leak-free. */
  dispose(): void {
    const disposers = [...this.ladder].reverse();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        this.contain(err);
      }
    }
    this.ladder.clear();
  }

  private contain(err: unknown): void {
    try {
      this.onError(err, { event: "(bus.dispose)", mode: "emit" });
    } catch {
      // never strand teardown
    }
  }
}
