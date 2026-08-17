// extensions — the typed Urban **extension-event taxonomy** and the extension host
// that runs the agentic-family / connector-pack surface through it (issue #262).
//
// `runtime.ts` used to wire every module directly and let extensions reach for
// whatever they needed; ordering and failure-isolation were implicit. This module
// formalizes the extension seams as a small set of **typed channels**, each with a
// declared dispatch mode (see `events.ts`), and gives extensions a single, uniform
// way to plug in: a `UrbanExtension` whose `setup()` registers listeners and
// disposable effects onto the app's dispose ladder.
//
// The first concrete consumer is exactly the informal plugin surface Urban already
// stresses today: nwf's agentic families ("drop a family module under
// `app/agentic/families/`, never edit `main.ts`") and connector packs. Each becomes
// a `UrbanExtension`; the runtime runs them through the `extension/register` serial
// checkpoint in a deterministic order, and everything they register tears down on
// `stop()` / dev-server HMR because it rode the dispose ladder.

import type { AppApi, Mounted } from "./context.ts";
import type { Logger } from "./logger.ts";
import {
  EventBus,
  type Disposer,
  type DispatchMode,
  type EmitChannel,
  type ParallelChannel,
  type SerialChannel,
  type WaterfallChannel,
} from "./events.ts";

// ---------------------------------------------------------------------------
// The taxonomy — the documented set of typed Urban extension events.
//
// Each seam is a canonical event *name* paired with its deliberate *dispatch
// mode*. This object is the single source of truth for the modes; the ADR's
// "feature → mechanism map" and the typed `UrbanEvents` channels below both derive
// from it, so the docs and the code cannot drift.
// ---------------------------------------------------------------------------

export const URBAN_EVENT_MODES = {
  /** Boot / start / stop notifications — observers never change the outcome. */
  "lifecycle": "emit",
  /** The ordered extension-registration checkpoint (this module's first consumer). */
  "extension/register": "serial",
  /** Request / action dispatch — around-middleware for transform / short-circuit. */
  "request/dispatch": "waterfall",
  /** Security / permission gate — a listener may short-circuit with a deny. */
  "security/gate": "waterfall",
  /** Instance-tracking reconcile — fan-out where every listener gets its chance. */
  "reconcile": "parallel",
} as const;

export type UrbanEventName = keyof typeof URBAN_EVENT_MODES;

/** A boot/start/stop lifecycle notification (the `lifecycle` emit seam). */
export interface LifecycleEvent {
  readonly app: string;
  readonly phase: "starting" | "started" | "stopping" | "stopped";
}

/** The payload handed to each extension as it registers (the `extension/register`
 *  serial seam): the just-registered extension plus its setup context. */
export interface ExtensionRegistered {
  readonly extension: string;
  readonly context: ExtensionSetupContext;
}

/** A request/action flowing through the `request/dispatch` waterfall seam. An
 *  extension middleware may transform it, short-circuit with a response, or
 *  recover a downstream throw. Kept transport-agnostic on purpose. */
export interface DispatchRequest {
  readonly kind: string;
  readonly payload: unknown;
}

export interface DispatchResponse {
  readonly handled: boolean;
  readonly payload: unknown;
}

/** A permission check flowing through the `security/gate` waterfall seam. A
 *  listener that denies short-circuits (never calls `next`). */
export interface GateRequest {
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
}

export interface GateDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

/** A reconcile tick fanned out on the `reconcile` parallel seam. */
export interface ReconcileEvent {
  readonly source: string;
  readonly at: number;
}

/** The typed Urban extension-event taxonomy: one channel per seam, each already
 *  bound to its declared dispatch mode. Modules and extensions adopt seams by
 *  registering on these channels; the dispatch semantics come from the channel,
 *  not the call site. */
export interface UrbanEvents {
  /** **emit** — lifecycle notifications. */
  readonly lifecycle: EmitChannel<LifecycleEvent>;
  /** **serial** — the ordered extension-registration checkpoint. */
  readonly extensionRegister: SerialChannel<ExtensionRegistered>;
  /** **waterfall** — request/action dispatch middleware. */
  readonly requestDispatch: WaterfallChannel<DispatchRequest, DispatchResponse>;
  /** **waterfall** — security/permission gate (short-circuit deny). */
  readonly securityGate: WaterfallChannel<GateRequest, GateDecision>;
  /** **parallel** — instance-tracking reconcile fan-out. */
  readonly reconcile: ParallelChannel<ReconcileEvent>;
}

/** Declare the whole Urban taxonomy on a bus — each seam exactly once, with the
 *  mode `URBAN_EVENT_MODES` records for it. */
export function createUrbanEvents(bus: EventBus): UrbanEvents {
  return {
    lifecycle: bus.emit<LifecycleEvent>("lifecycle"),
    extensionRegister: bus.serial<ExtensionRegistered>("extension/register"),
    requestDispatch: bus.waterfall<DispatchRequest, DispatchResponse>("request/dispatch"),
    securityGate: bus.waterfall<GateRequest, GateDecision>("security/gate"),
    reconcile: bus.parallel<ReconcileEvent>("reconcile"),
  };
}

/** Assert (at construction) that the typed taxonomy and the documented mode table
 *  agree — a guard against the two drifting apart. */
export function urbanEventMode(name: UrbanEventName): DispatchMode {
  return URBAN_EVENT_MODES[name];
}

// ---------------------------------------------------------------------------
// The extension host — the first consumer of the taxonomy.
// ---------------------------------------------------------------------------

/** What an extension's `setup()` gets: the app API, the typed taxonomy to hook
 *  onto, a structured logger, and `effect()` to hang any other disposable resource
 *  (a timer, a subscription) on the dispose ladder. */
export interface ExtensionSetupContext {
  readonly app: AppApi;
  readonly events: UrbanEvents;
  readonly log: Logger;
  /** Register a disposable effect (a timer, listener, subscription). It joins the
   *  dispose ladder, so `stop()` / HMR tears it down with everything else. */
  effect(dispose: Disposer): void;
}

/** A pluggable Urban extension — the uniform shape an agentic family or a
 *  connector pack presents to the runtime. `setup()` wires the extension onto the
 *  taxonomy; anything it registers is an effect on the dispose ladder. */
export interface UrbanExtension {
  readonly name: string;
  /** Explicit ordering for the `extension/register` serial checkpoint; lower runs
   *  first. Extensions with equal (or absent) order keep registration order. */
  readonly order?: number;
  setup(context: ExtensionSetupContext): void | Promise<void>;
}

export interface ExtensionHost extends Mounted {
  /** The typed taxonomy this host mounted the extensions onto. */
  readonly events: UrbanEvents;
  /** Live listener count across the taxonomy — 0 after `stop()`. */
  readonly listenerCount: number;
}

export interface MountExtensionsOptions {
  /** Reports a contained extension throw (defaults to the app logger's `warn`). */
  onError?: (err: unknown, info: { event: string; mode: DispatchMode }) => void;
  /** A pre-built taxonomy/bus to mount onto (the runtime shares one app-wide). When
   *  omitted a private bus is created — handy for isolated tests. */
  bus?: EventBus;
  events?: UrbanEvents;
}

/** Run `extensions` through the taxonomy: deterministically order them, `setup()`
 *  each behind the `extension/register` serial checkpoint (a throwing extension is
 *  contained and never strands the others or app boot), and return a `Mounted`
 *  whose `stop()` unwinds the whole dispose ladder LIFO — so a start→stop→start
 *  cycle (or HMR reload) leaks no listeners. */
export async function mountExtensions(
  api: AppApi,
  extensions: readonly UrbanExtension[],
  options: MountExtensionsOptions = {},
): Promise<ExtensionHost> {
  const log = api.log.child({ module: "extensions" });
  const bus =
    options.bus ??
    new EventBus({
      onError:
        options.onError ??
        ((err, info) => log.warn("extension listener threw and was contained", { event: info.event, mode: info.mode, error: String(err) })),
    });
  const events = options.events ?? createUrbanEvents(bus);

  // Deterministic order: primary by `order` (default 0), stable within ties by the
  // order the host handed them to us. A sibling dropping a family module gets a
  // predictable slot without editing anyone else's registration.
  const ordered = extensions
    .map((extension, index) => ({ extension, index }))
    .sort((a, b) => (a.extension.order ?? 0) - (b.extension.order ?? 0) || a.index - b.index)
    .map((entry) => entry.extension);

  const context: ExtensionSetupContext = {
    app: api,
    events,
    log,
    effect(dispose) {
      bus.effect(dispose);
    },
  };

  for (const extension of ordered) {
    // `setup()` is the checkpoint's unit of work. A throw is contained here so one
    // bad extension never strands app boot or its siblings — it warns and delegates.
    try {
      await extension.setup(context);
    } catch (err) {
      log.warn("extension setup threw and was contained", { extension: extension.name, error: String(err) });
      continue;
    }
    // Notify the ordered `extension/register` serial checkpoint so observers react
    // in a deterministic order (also contained, per `SerialChannel.run`).
    await events.extensionRegister.run({ extension: extension.name, context });
    log.info("extension mounted", { extension: extension.name });
  }

  return {
    name: "extensions",
    events,
    get listenerCount() {
      return bus.listenerCount;
    },
    async stop() {
      bus.dispose();
    },
    describe() {
      return { extensions: ordered.map((e) => e.name), listeners: bus.listenerCount };
    },
  };
}
