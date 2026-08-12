/**
 * @nanobpm/agentic-cockpit — the visibility page (the cockpit) for the Nano
 * agentic protocol (ADR 0056, slice S8).
 *
 * The operator's cockpit over the one app-tier channel: a per-network
 * demand×supply matrix, a red light per *missing agent type*, the diversity-SLO
 * state (all from the S4 {@link cockpitView} projection of `@nanobpm/agentic-demand`),
 * and drill-into-a-worker → a live terminal over the S5 relay
 * ({@link TerminalSession} + {@link RelayChannelClient}) that **survives a cockpit
 * reconnect** via resume-from-offset.
 *
 * The package is a framework-free, injection-based core: {@link bootCockpit}
 * wires polling, rendering and the terminal from an injected {@link CockpitEnv},
 * with no hard dependency on the DOM, a socket implementation, or xterm.js. Both
 * shells under `page/` — the standalone one and the console App-View embed — call
 * the SAME {@link bootCockpit} against the SAME {@link renderCockpit}, so the page
 * renders identically whether embedded or standalone.
 *
 * The wire contract is `@nanobpm/agentic-protocol`; the report comes from
 * `@nanobpm/agentic-demand`; the relay sub-protocol from `@nanobpm/agentic-relay`.
 * Nothing here rides the Camunda-8 engine or its transport.
 */
export {
  cockpitView,
  type CockpitLight,
  type CockpitNetworkRow,
  type CockpitTokenRow,
  type CockpitView,
  type SloStatus,
} from "./view.ts";

export {
  TerminalSession,
  type RelayInbound,
  type RelayOutbound,
  type RelaySend,
  type TerminalSessionOptions,
  type TerminalSink,
} from "./terminal-session.ts";

export {
  RelayChannelClient,
  type RawSocket,
  type RelayChannelClientOptions,
  type Scheduler,
  type SocketFactory,
} from "./relay-client.ts";

export {
  renderCockpit,
  type CockpitDom,
  type DocumentLike,
  type ElementLike,
  type RenderOptions,
} from "./render.ts";

export {
  bootCockpit,
  type CockpitEnv,
  type CockpitHandle,
  type CreateTerminal,
  type TimerHandle,
} from "./boot.ts";
