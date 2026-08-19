// Unit tests for the PII classifier (slice S6 core). Run via
// `npm run test --workspace @nanobpm/urban` (node --test, src/**/*.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyPii, isPiiClean, type PiiCandidate, type PiiKind } from "./classifier.ts";
import { MEMORY_RECORD_SCHEMA_VERSION, type MemoryRecord } from "../schema/index.ts";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const full: MemoryRecord = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: "rec-1",
    scope: "repo",
    mode: "empirical",
    provenance: "human",
    authority: "authoritative",
    statement: "the build is green after fixing the test failure",
    createdAt: "2026-08-19T14:00:00.000Z",
  };
  return { ...full, ...overrides };
}

function kinds(input: PiiCandidate): PiiKind[] {
  const r = classifyPii(input);
  return r.clean ? [] : r.findings.map((f) => f.kind);
}

test("clean record classifies clean", () => {
  const result = classifyPii(record());
  assert.equal(result.clean, true);
  assert.deepEqual(result.findings, []);
  assert.equal(isPiiClean(record()), true);
});

test("numeric and timestamp fields never false-positive", () => {
  // schemaVersion (number) and createdAt (ISO 4-2-2) must not trip phone/ssn/date detectors.
  const result = classifyPii(record({ statement: "shipped at 2026-08-19T14:00:00.000Z, v1.2.3" }));
  assert.equal(result.clean, true);
});

test("detects a plain email", () => {
  assert.ok(kinds("contact alice@example.com for details").includes("email"));
});

test("detects obfuscated emails", () => {
  assert.ok(kinds("reach alice (at) example dot com").includes("email"));
  assert.ok(kinds("reach alice[at]example[dot]com").includes("email"));
  assert.ok(kinds("reach alice AT example DOT com").includes("email"));
});

test("reports BOTH plain and obfuscated emails in the same field", () => {
  // A plain email must not suppress obfuscated hits elsewhere in the same field:
  // the dedupe is per-location, not a field-wide "already saw an email" flag.
  const result = classifyPii("alice@example.com and reach bob (at) example dot com");
  assert.equal(result.clean, false);
  if (!result.clean) {
    const emails = result.findings.filter((f) => f.kind === "email");
    assert.equal(emails.length, 2);
    assert.ok(emails.some((f) => f.reason === "email address"));
    assert.ok(emails.some((f) => f.reason === "obfuscated email address"));
  }
});

test("detects US SSN", () => {
  assert.ok(kinds("ssn 123-45-6789 on file").includes("ssn"));
});

test("detects phone numbers but not ISO timestamps", () => {
  assert.ok(kinds("call +1 (415) 555-0132 tomorrow").includes("phone"));
  assert.ok(kinds("call 415-555-0132").includes("phone"));
  assert.equal(kinds("2026-08-19T14:00:00").includes("phone"), false);
});

test("detects Luhn-valid credit-card numbers, ignores random digit runs", () => {
  // 4242 4242 4242 4242 is a Luhn-valid test card.
  assert.ok(kinds("card 4242 4242 4242 4242 expires soon").includes("credit-card"));
  // A 16-digit non-Luhn run must NOT be flagged as a card.
  assert.equal(kinds("ticket 1234123412341234 in tracker").includes("credit-card"), false);
});

test("detects IPv4 addresses with valid octets only", () => {
  assert.ok(kinds("connect to 192.168.1.10").includes("ip-address"));
  // 999 is out of range — not a valid octet.
  assert.equal(kinds("version 999.1.1.1").includes("ip-address"), false);
});

test("detects secrets: AWS key id, private key, JWT", () => {
  assert.ok(kinds("AKIAIOSFODNN7EXAMPLE").includes("aws-access-key-id"));
  assert.ok(kinds("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").includes("private-key"));
  assert.ok(
    kinds("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w")
      .includes("jwt"),
  );
});

test("scans every string field of a record and reports its path", () => {
  const result = classifyPii(
    record({ statement: "no pii here", subject: "email bob@corp.example.org" }),
  );
  assert.equal(result.clean, false);
  if (!result.clean) {
    const emailFinding = result.findings.find((f) => f.kind === "email");
    assert.ok(emailFinding);
    assert.equal(emailFinding?.path, "subject");
  }
});

test("scans string-array fields (evidence[]) with an indexed path", () => {
  const result = classifyPii(record({ evidence: ["ok", "ssn 123-45-6789"] }));
  assert.equal(result.clean, false);
  if (!result.clean) {
    const finding = result.findings.find((f) => f.kind === "ssn");
    assert.equal(finding?.path, "evidence.1");
  }
});

test("walks nested objects (no shallow false-negative through the guard)", () => {
  const result = classifyPii({ meta: { contact: { email: "alice@example.com" } } });
  assert.equal(result.clean, false);
  if (!result.clean) {
    const finding = result.findings.find((f) => f.kind === "email");
    assert.equal(finding?.path, "meta.contact.email");
  }
});

test("walks arrays of nested objects with a fully indexed path", () => {
  const result = classifyPii({ items: [{ note: "ok" }, { note: "ssn 123-45-6789" }] });
  assert.equal(result.clean, false);
  if (!result.clean) {
    const finding = result.findings.find((f) => f.kind === "ssn");
    assert.equal(finding?.path, "items.1.note");
  }
});

test("obfuscated-email finding index maps back to the original text offset", () => {
  const text = "reach alice (at) example dot com now";
  const result = classifyPii(text);
  assert.equal(result.clean, false);
  if (!result.clean) {
    const finding = result.findings.find((f) => f.reason === "obfuscated email address");
    assert.ok(finding);
    // Must locate the value in the ORIGINAL text, not the shorter normalised copy.
    assert.equal(finding?.index, text.indexOf("alice"));
  }
});

test("findings are located and redacted, never re-leaking the value", () => {
  const value = "alice@example.com";
  const result = classifyPii(`email ${value}`);
  assert.equal(result.clean, false);
  if (!result.clean) {
    const f = result.findings[0];
    assert.equal(typeof f.index, "number");
    assert.ok(f.index >= 0);
    assert.equal(f.excerpt.includes(value), false);
    // Defect class: the excerpt must not leak ANY 2-char run of the value — not
    // just the whole string. A first/last-character redaction would slip through
    // an `includes(value)` check while still surfacing part of the secret.
    for (let i = 0; i + 2 <= value.length; i++) {
      assert.equal(
        f.excerpt.includes(value.slice(i, i + 2)),
        false,
        `excerpt leaked substring "${value.slice(i, i + 2)}"`,
      );
    }
  }
});

test("reports multiple occurrences", () => {
  const result = classifyPii("a@x.com and b@y.com");
  assert.equal(result.clean, false);
  if (!result.clean) {
    assert.ok(result.findings.filter((f) => f.kind === "email").length >= 2);
  }
});

test("is pure — repeated calls on the same input are identical", () => {
  const input = record({ statement: "phone 415-555-0132" });
  assert.deepEqual(classifyPii(input), classifyPii(input));
});
