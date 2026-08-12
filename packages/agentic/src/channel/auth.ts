/**
 * Connection authentication.
 *
 * A peer authenticates at the app-tier handshake with an ADR 0028 identity
 * token PLUS a capability credential — the same pattern nano-workforce's
 * blackboard hook already uses (`?token=…`). This is a connection-level gate:
 * capability (cognition / weight / family / host) travels later on the
 * `register` frame as an enrolment attribute and is NEVER a routing token.
 *
 * The hub takes any {@link Authenticator}; {@link sharedSecretAuthenticator} is
 * the batteries-included default.
 */
import { timingSafeEqual } from "node:crypto";
import type { HandshakeRequest } from "./connection.ts";

/** What the authenticator grants a peer once it passes the gate. */
export interface AuthGrant {
  /** The authenticated principal (ADR 0028 identity). */
  readonly identity: string;
  /** Optional scope the identity is confined to (e.g. a plan/network). */
  readonly scope?: string;
  /** The capability credential the peer presented, if any. */
  readonly capability?: string;
}

/** Application close code for a rejected identity token. */
export const AUTH_UNAUTHORIZED = 4401;
/** Application close code for a missing/rejected capability credential. */
export const AUTH_FORBIDDEN = 4403;

export type AuthResult =
  | { readonly ok: true; readonly grant: AuthGrant }
  | { readonly ok: false; readonly code: number; readonly reason: string };

/** Verifies a handshake and either grants or rejects the connection. */
export type Authenticator = (req: HandshakeRequest) => AuthResult | Promise<AuthResult>;

/**
 * Constant-time string comparison. Unequal-length inputs short-circuit to
 * `false` (length is not itself secret here); equal-length inputs are compared
 * in constant time via {@link timingSafeEqual}.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Read the identity token from the handshake (explicit field or `token` query). */
function tokenOf(req: HandshakeRequest): string | undefined {
  return req.token ?? req.query?.token;
}

/**
 * Read the capability credential from the handshake: explicit field, the
 * `capability` query param, or the `x-capability-credential` header.
 */
function credentialOf(req: HandshakeRequest): string | undefined {
  return req.credential ?? req.query?.capability ?? req.headers?.["x-capability-credential"];
}

export interface SharedSecretAuthOptions {
  /** The shared identity-token secret every valid peer presents. */
  readonly secret: string;
  /** Require a capability credential too (default true). */
  readonly requireCredential?: boolean;
  /** Extra check on the credential; return false to reject. Default accept-any. */
  readonly verifyCredential?: (credential: string, identity: string) => boolean;
  /** Derive the identity from the handshake. Default: the token itself, or `anonymous`. */
  readonly identityFor?: (req: HandshakeRequest) => string;
}

/**
 * The default authenticator: a shared-secret identity token gate plus a required
 * capability credential. Mirrors nano-workforce's blackboard-hook `?token=…`
 * pattern; swap in a real ADR 0028 verifier by passing your own
 * {@link Authenticator} to the hub.
 */
export function sharedSecretAuthenticator(options: SharedSecretAuthOptions): Authenticator {
  const requireCredential = options.requireCredential ?? true;
  return (req: HandshakeRequest): AuthResult => {
    const token = tokenOf(req);
    if (token === undefined || !safeEqual(token, options.secret)) {
      return { ok: false, code: AUTH_UNAUTHORIZED, reason: "invalid identity token" };
    }
    const identity = options.identityFor ? options.identityFor(req) : (req.remote ?? "anonymous");
    const credential = credentialOf(req);
    if (requireCredential) {
      if (credential === undefined || credential.length === 0) {
        return { ok: false, code: AUTH_FORBIDDEN, reason: "missing capability credential" };
      }
      if (options.verifyCredential && !options.verifyCredential(credential, identity)) {
        return { ok: false, code: AUTH_FORBIDDEN, reason: "capability credential rejected" };
      }
    }
    return { ok: true, grant: { identity, capability: credential } };
  };
}
