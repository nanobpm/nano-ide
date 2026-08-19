/**
 * @nanobpm/agentic — the Nano agentic protocol (ADR 0056).
 *
 * One app-tier channel carrying agent presence/registry, demand×supply, a shared
 * blackboard and a live terminal relay. This barrel re-exports every family as a
 * namespace; most consumers import the specific subpath they need instead, e.g.
 * `@nanobpm/agentic/channel`, `@nanobpm/agentic/relay`, `@nanobpm/agentic/cockpit`.
 */
export * as protocol from "./protocol/index.ts";
export * as channel from "./channel/index.ts";
export * as presence from "./presence/index.ts";
export * as vocab from "./vocab/index.ts";
export * as demand from "./demand/index.ts";
export * as relay from "./relay/index.ts";
export * as session from "./session/index.ts";
export * as transcript from "./transcript/index.ts";
export * as blackboard from "./blackboard/index.ts";
export * as cockpit from "./cockpit/index.ts";
