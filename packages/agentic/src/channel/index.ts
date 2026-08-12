/**
 * @nanobpm/agentic-channel — the app-tier channel & hub for the Nano agentic
 * protocol (ADR 0056, slice S1).
 *
 * Stands up a WebSocket server on the app's OWN bound port, authenticates each
 * peer (ADR 0028 identity + capability credential), tracks it in a connection
 * registry with liveness, and routes inbound frames to per-family handlers via
 * the {@link FamilyRouter} registration seam — the canonical extension point
 * every family module (S2 presence, S5 relay, S7 blackboard) attaches to.
 *
 * The wire contract itself lives in `@nanobpm/agentic-protocol`; this package
 * builds on it. The Camunda-8 engine transport is a separate connection and is
 * never touched.
 */
export { AgenticHub, LIVENESS_TIMEOUT } from "./hub.ts";
export type { AgenticHubOptions, HubConnection } from "./hub.ts";

export {
  FamilyRouter,
  UnknownFamilyError,
  DuplicateFamilyHandlerError,
} from "./dispatch.ts";
export type { FamilyHandler } from "./dispatch.ts";

export { ConnectionRegistry } from "./registry.ts";
export type {
  ConnectionRegistryOptions,
  Presence,
  RegisteredConnection,
} from "./registry.ts";

export {
  sharedSecretAuthenticator,
  AUTH_UNAUTHORIZED,
  AUTH_FORBIDDEN,
} from "./auth.ts";
export type {
  Authenticator,
  AuthGrant,
  AuthResult,
  SharedSecretAuthOptions,
} from "./auth.ts";

export { WebSocketChannelTransport } from "./ws-transport.ts";
export type { WebSocketChannelTransportOptions } from "./ws-transport.ts";

export { systemClock } from "./clock.ts";
export type { Clock } from "./clock.ts";

export type {
  ChannelConnection,
  ChannelTransport,
  CloseCode,
  HandshakeRequest,
} from "./connection.ts";
