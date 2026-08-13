import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToken, parseToken, isValidToken, TokenParseError } from "./token.ts";
import { VALID_TOKENS, INVALID_TOKENS } from "./conformance/tokens.ts";

test("valid tokens parse into the expected decomposition", () => {
  for (const vector of VALID_TOKENS) {
    assert.deepEqual(parseToken(vector.token), vector.parsed, vector.name);
    assert.ok(isValidToken(vector.token), vector.name);
  }
});

test("valid tokens round-trip through formatToken", () => {
  for (const vector of VALID_TOKENS) {
    assert.equal(formatToken(parseToken(vector.token)), vector.token, vector.name);
  }
});

test("formatToken rejects subnetworks without a network", () => {
  assert.throws(
    () => formatToken({ subnetworks: ["sub"], role: "decide" }),
    /subnetworks present without a network/,
  );
});

test("formatToken rejects a RoutingToken with an invalid segment", () => {
  assert.throws(
    () => formatToken({ network: "Net", subnetworks: [], role: "decide" }),
    /invalid segment: Net/,
  );
  assert.throws(
    () => formatToken({ network: "mesh", subnetworks: ["Bad_Sub"], role: "decide" }),
    /invalid segment: Bad_Sub/,
  );
});

test("formatToken rejects a RoutingToken with an invalid seat label", () => {
  assert.throws(
    () => formatToken({ subnetworks: [], role: "decide", seat: "Seat#1" }),
    /invalid seat label: Seat#1/,
  );
});

test("invalid tokens reject with the specified error code", () => {
  for (const vector of INVALID_TOKENS) {
    assert.throws(
      () => parseToken(vector.token),
      (error: unknown) => {
        assert.ok(error instanceof TokenParseError, `${vector.name}: expected TokenParseError`);
        assert.equal(error.code, vector.expected, vector.name);
        return true;
      },
      vector.name,
    );
    assert.ok(!isValidToken(vector.token), vector.name);
  }
});
