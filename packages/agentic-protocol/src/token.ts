/**
 * Routing-token grammar: `network[.subnetwork…].role[#seat]`.
 *
 * The token is what the engine matches 1:1. Capability — cognition, weight,
 * family, host — is NEVER encoded in the token; it is an enrolment attribute
 * and a registry gate. Do not smuggle capability into a segment.
 *
 * Grammar:
 *   token   = segment ("." segment)* ("#" seat)?
 *   segment = [a-z][a-z0-9-]*        (first is the network, last is the role,
 *                                     any in between are subnetworks)
 *   seat    = [a-z0-9-]+
 *
 * A single-segment token (e.g. `decide`) is a bare role with no network and no
 * subnetworks (`network` is absent).
 */
export interface RoutingToken {
  readonly network?: string;
  readonly subnetworks: readonly string[];
  readonly role: string;
  readonly seat?: string;
}

const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const SEAT_RE = /^[a-z0-9-]+$/;

/** True when `name` is a valid network/subnetwork/role segment. */
export function isSegmentName(name: string): boolean {
  return SEGMENT_RE.test(name);
}

/** True when `seat` is a valid seat label. */
export function isSeatLabel(seat: string): boolean {
  return SEAT_RE.test(seat);
}

export type TokenParseErrorCode =
  | "empty"
  | "whitespace"
  | "multiple-seat-markers"
  | "empty-seat"
  | "bad-seat"
  | "empty-segment"
  | "bad-segment";

export class TokenParseError extends Error {
  readonly code: TokenParseErrorCode;
  constructor(code: TokenParseErrorCode, message: string) {
    super(message);
    this.name = "TokenParseError";
    this.code = code;
  }
}

export function parseToken(token: string): RoutingToken {
  if (token.length === 0) {
    throw new TokenParseError("empty", "routing token must not be empty");
  }
  if (/\s/.test(token)) {
    throw new TokenParseError("whitespace", "routing token must not contain whitespace");
  }

  const hashParts = token.split("#");
  if (hashParts.length > 2) {
    throw new TokenParseError("multiple-seat-markers", "routing token has more than one '#'");
  }
  const pathPart = hashParts[0];
  const seatPart = hashParts.length === 2 ? hashParts[1] : undefined;

  if (seatPart !== undefined) {
    if (seatPart.length === 0) {
      throw new TokenParseError("empty-seat", "seat after '#' must not be empty");
    }
    if (!isSeatLabel(seatPart)) {
      throw new TokenParseError("bad-seat", `invalid seat label: ${seatPart}`);
    }
  }

  const segments = pathPart.split(".");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new TokenParseError("empty-segment", "routing token has an empty '.' segment");
    }
    if (!isSegmentName(segment)) {
      throw new TokenParseError("bad-segment", `invalid token segment: ${segment}`);
    }
  }

  const role = segments[segments.length - 1];
  const base =
    segments.length === 1
      ? { subnetworks: [], role }
      : { network: segments[0], subnetworks: segments.slice(1, -1), role };
  return seatPart === undefined ? base : { ...base, seat: seatPart };
}

export function isValidToken(token: string): boolean {
  try {
    parseToken(token);
    return true;
  } catch {
    return false;
  }
}

export function formatToken(token: RoutingToken): string {
  if (token.network === undefined && token.subnetworks.length > 0) {
    throw new Error("invalid RoutingToken: subnetworks present without a network");
  }
  const segments = token.network === undefined
    ? [token.role]
    : [token.network, ...token.subnetworks, token.role];
  const path = segments.join(".");
  return token.seat === undefined ? path : `${path}#${token.seat}`;
}
