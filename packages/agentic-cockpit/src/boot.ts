/**
 * The cockpit boot/orchestration layer — S8.
 *
 * Wires the whole page together from injected capabilities, with **no** direct
 * dependency on the browser, a socket implementation, or xterm.js — everything is
 * passed in ({@link CockpitEnv}). That is what makes the page render *identically*
 * embedded (console App View) and standalone (the two shells differ only in the
 * `host` element and the concrete capabilities they inject), and what makes the
 * live-refresh + drill-in + resume-on-reconnect path unit-testable on Node.
 *
 * Responsibilities:
 *  - a **self-scheduling** poll of the S4 demand×supply report that re-renders the
 *    matrix/lights each pass (a slow fetch can't overlap the next — mirrors the
 *    nano-workforce poller discipline);
 *  - **drill-into-a-worker**: open a {@link RelayChannelClient} + {@link TerminalSession}
 *    for the selected stream, mount its output into a *persistent* terminal region
 *    (so a matrix refresh never wipes it), and re-attach on every reconnect so the
 *    terminal **survives a cockpit reconnect** via resume-from-offset.
 */
import type { DemandSupplyReport } from "@nanobpm/agentic-demand";
import { RelayChannelClient, type Scheduler, type SocketFactory } from "./relay-client.ts";
import { type DocumentLike, type ElementLike, renderCockpit } from "./render.ts";
import { TerminalSession, type TerminalSink } from "./terminal-session.ts";
import { cockpitView } from "./view.ts";

/** Mounts a terminal into `host` and returns the sink relay output is written to. */
export type CreateTerminal = (host: ElementLike) => TerminalSink;

/** An opaque poll-timer handle (a Node `Timeout` or a browser timer id). */
export type TimerHandle = unknown;

export interface CockpitEnv {
  /** The element the cockpit renders into (standalone: `document.body`; embedded: the App View host). */
  readonly host: ElementLike;
  /** The document the renderer creates elements from. */
  readonly doc: DocumentLike;
  /** Fetches the latest S4 demand×supply report (e.g. over HTTP or the channel). */
  readonly fetchReport: () => Promise<DemandSupplyReport>;
  /** Opens a socket to the app relay channel (one per drill-in connection). */
  readonly connectRelay: SocketFactory;
  /** Mounts the terminal widget (xterm.js in the browser) and returns its write sink. */
  readonly createTerminal: CreateTerminal;
  /** Reconnect scheduler for the relay client. Default `setTimeout(run, 0)`. */
  readonly schedule?: Scheduler;
  /** Poll scheduler. Default `setTimeout`. Injected so tests drive it by hand. Must be paired with {@link clearTimer}. */
  readonly setTimer?: (run: () => void, ms: number) => TimerHandle;
  /** Cancels a poll timer. Default `clearTimeout`. Must be paired with {@link setTimer}. */
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** Poll interval in ms. Default 2000. */
  readonly refreshMs?: number;
  /** Bulk credit granted per terminal (re)subscribe. Default 1024. */
  readonly credit?: number;
  /** Notified of a fetch/render/relay error (the poll keeps going). */
  readonly onError?: (err: unknown) => void;
}

/** The running cockpit; dispose to stop polling and tear down the terminal. */
export interface CockpitHandle {
  /** Run one fetch→render pass now (also the poll body). Resolves when rendered. */
  refresh(): Promise<void>;
  /** Start the self-scheduling poll loop (runs one pass immediately). */
  start(): void;
  /** Stop the poll loop (leaves the last render in place). */
  stop(): void;
  /** Drill into a worker's relay stream, opening a resumable live terminal. */
  drill(stream: string): void;
  /** The stream currently drilled into, if any. */
  readonly currentStream: string | undefined;
  /** Stop everything and release the terminal connection. */
  dispose(): void;
}

const DEFAULT_REFRESH_MS = 2000;

interface Drill {
  readonly stream: string;
  readonly client: RelayChannelClient;
}

class Cockpit implements CockpitHandle {
  readonly #env: CockpitEnv;
  readonly #matrixRegion: ElementLike;
  readonly #terminalHost: ElementLike;
  readonly #refreshMs: number;
  readonly #setTimer: (run: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  readonly #timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  #nextTimerId = 0;
  #timer: TimerHandle | undefined;
  #running = false;
  #disposed = false;
  #drill: Drill | undefined;

  constructor(env: CockpitEnv) {
    this.#env = env;
    this.#refreshMs = env.refreshMs ?? DEFAULT_REFRESH_MS;
    // setTimer/clearTimer are a matched pair: a caller-supplied setTimer returns
    // opaque handles the default clearTimer (which only understands the internal
    // numeric-handle Map) cannot cancel, leaving an un-stoppable poll loop. Fail
    // fast rather than silently accept one without the other.
    if ((env.setTimer === undefined) !== (env.clearTimer === undefined)) {
      throw new Error("CockpitEnv.setTimer and clearTimer must be provided together (or neither)");
    }
    // Default timer path uses numeric handles backed by a Map, so no unchecked
    // cast is needed to feed an opaque handle back to clearTimeout (`as` is banned).
    this.#setTimer =
      env.setTimer ??
      ((run, ms) => {
        const id = this.#nextTimerId++;
        this.#timeouts.set(
          id,
          setTimeout(() => {
            this.#timeouts.delete(id);
            run();
          }, ms),
        );
        return id;
      });
    this.#clearTimer =
      env.clearTimer ??
      ((handle) => {
        if (typeof handle !== "number") return;
        const timeout = this.#timeouts.get(handle);
        if (timeout !== undefined) {
          clearTimeout(timeout);
          this.#timeouts.delete(handle);
        }
      });

    // Build the stable skeleton once: a volatile matrix region the poll
    // re-renders, and a PERSISTENT terminal region a refresh never touches.
    env.host.replaceChildren();
    const shell = env.doc.createElement("div");
    shell.className = "cockpit-shell";
    this.#matrixRegion = env.doc.createElement("div");
    this.#matrixRegion.className = "cockpit-matrix-region";
    const terminalPanel = env.doc.createElement("section");
    terminalPanel.className = "cockpit-terminal";
    const title = env.doc.createElement("h2");
    title.className = "cockpit-panel-title";
    title.textContent = "Worker terminal";
    terminalPanel.appendChild(title);
    this.#terminalHost = env.doc.createElement("div");
    this.#terminalHost.className = "cockpit-terminal-host";
    this.#terminalHost.setAttribute("data-terminal", "host");
    terminalPanel.appendChild(this.#terminalHost);
    shell.appendChild(this.#matrixRegion);
    shell.appendChild(terminalPanel);
    env.host.appendChild(shell);
  }

  get currentStream(): string | undefined {
    return this.#drill?.stream;
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    let report: DemandSupplyReport;
    try {
      report = await this.#env.fetchReport();
    } catch (err) {
      this.#env.onError?.(err);
      return;
    }
    if (this.#disposed) return;
    try {
      renderCockpit(this.#matrixRegion, this.#env.doc, cockpitView(report), {
        onDrill: (stream) => this.drill(stream),
      });
    } catch (err) {
      this.#env.onError?.(err);
    }
  }

  start(): void {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    this.#tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  #tick(): void {
    // Self-scheduling: schedule the NEXT pass only after this one settles, so a
    // slow fetch can never overlap its successor.
    void this.refresh().finally(() => {
      if (!this.#running || this.#disposed) return;
      this.#timer = this.#setTimer(() => this.#tick(), this.#refreshMs);
    });
  }

  drill(stream: string): void {
    if (this.#disposed) return;
    if (this.#drill?.stream === stream) return;
    this.#drill?.client.close();

    // Fresh terminal for the newly selected worker.
    this.#terminalHost.replaceChildren();
    const sink = this.#env.createTerminal(this.#terminalHost);

    let session: TerminalSession | undefined;
    const client = new RelayChannelClient({
      connect: this.#env.connectRelay,
      onRelay: (message) => session?.handle(message),
      // Re-attach on EVERY (re)connect → resume-from-offset: the terminal
      // survives a cockpit reconnect without losing or double-writing output.
      onOpen: () => session?.attach(),
      schedule: this.#env.schedule,
      onError: (err) => this.#env.onError?.(err),
    });
    session = new TerminalSession({
      stream,
      sink,
      send: (message) => client.sendRelay(message),
      credit: this.#env.credit,
    });
    this.#drill = { stream, client };
    client.open();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.#drill?.client.close();
    this.#drill = undefined;
  }
}

/** Boot the cockpit against an injected environment. Call {@link CockpitHandle.start} to poll. */
export function bootCockpit(env: CockpitEnv): CockpitHandle {
  return new Cockpit(env);
}
