import type { RoutingToken, TokenParseErrorCode } from "../token.ts";

/**
 * Routing-token vectors. Valid ones assert the parse decomposes exactly as
 * `network[.subnetwork…].role[#seat]`; invalid ones assert the grammar rejects
 * with a specific {@link TokenParseErrorCode}. Capability is never present in a
 * token — there is deliberately no "capability" field to parse.
 */
export interface ValidToken {
  readonly name: string;
  readonly token: string;
  readonly parsed: RoutingToken;
}

export interface InvalidToken {
  readonly name: string;
  readonly token: string;
  readonly expected: TokenParseErrorCode;
}

export const VALID_TOKENS: readonly ValidToken[] = [
  {
    name: "single-segment-role",
    token: "decide",
    parsed: { subnetworks: [], role: "decide" },
  },
  {
    name: "network-and-role",
    token: "planning.decide",
    parsed: { network: "planning", subnetworks: [], role: "decide" },
  },
  {
    name: "nested-subnetwork",
    token: "implementation.ci.fix",
    parsed: { network: "implementation", subnetworks: ["ci"], role: "fix" },
  },
  {
    name: "role-with-named-seat",
    token: "qa.review#red",
    parsed: { network: "qa", subnetworks: [], role: "review", seat: "red" },
  },
  {
    name: "role-with-numeric-seat",
    token: "implementation.qa.red#1",
    parsed: { network: "implementation", subnetworks: ["qa"], role: "red", seat: "1" },
  },
  {
    name: "hyphenated-segments",
    token: "code-review.fast-lane.senior-dev#blue",
    parsed: {
      network: "code-review",
      subnetworks: ["fast-lane"],
      role: "senior-dev",
      seat: "blue",
    },
  },
];

export const INVALID_TOKENS: readonly InvalidToken[] = [
  { name: "empty", token: "", expected: "empty" },
  { name: "whitespace", token: "planning .decide", expected: "whitespace" },
  { name: "leading-dot", token: ".decide", expected: "empty-segment" },
  { name: "trailing-dot", token: "planning.", expected: "empty-segment" },
  { name: "double-dot", token: "planning..decide", expected: "empty-segment" },
  { name: "uppercase-segment", token: "Planning.decide", expected: "bad-segment" },
  { name: "segment-starts-with-digit", token: "1planning.decide", expected: "bad-segment" },
  { name: "two-seat-markers", token: "qa.review#red#blue", expected: "multiple-seat-markers" },
  { name: "empty-seat", token: "qa.review#", expected: "empty-seat" },
  { name: "uppercase-seat", token: "qa.review#Red", expected: "bad-seat" },
];
