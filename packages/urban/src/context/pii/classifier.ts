// Slice S6 CORE (pii guard-core) — the PII *classifier*.
//
// A PURE, dependency-free function that inspects candidate memory-record content
// and reports whether it carries personally-identifiable information (PII) or
// PII-adjacent secrets. It is the analytical core the mandatory pre-commit guard
// (`./guard.ts`) is built on: the guard decides *policy* (default-DENY), this
// module decides *facts* (what looks like PII and where).
//
// Design goals:
//  - PURE & deterministic: same input → same classification, no I/O, no state.
//    Safe to call on a hot path (S3 runs it before every commit) and trivial to
//    unit-test and reuse (the S6 CI slice reuses it to scan staged records).
//  - By-construction MVP: the context substrate is *no-PII*, so the classifier
//    is deliberately conservative-to-strict — it errs toward flagging obfuscated
//    look-alikes (e.g. `name (at) host dot com`) because a false *positive* is a
//    safe rejection while a false *negative* would launder PII into the record.
//  - Located findings: every hit reports the field `path` and offset so callers
//    (and humans) can see exactly what was flagged and why.

import type { MemoryRecord } from "../schema/index.ts";

/** The categories of PII / sensitive material the classifier recognises. */
export type PiiKind =
  | "email"
  | "phone"
  | "ssn"
  | "credit-card"
  | "ip-address"
  | "aws-access-key-id"
  | "private-key"
  | "jwt";

/** A single located detection. */
export interface PiiFinding {
  /** Which category matched. */
  readonly kind: PiiKind;
  /**
   * Dotted path to the offending field within the candidate. Empty (`""`) when
   * the candidate is a bare string. For array elements the index is appended,
   * e.g. `evidence.0`.
   */
  readonly path: string;
  /** Character offset of the match within that field's text. */
  readonly index: number;
  /** The matched substring, partially redacted so the finding never re-leaks the value. */
  readonly excerpt: string;
  /** Human-readable explanation of why this was flagged. */
  readonly reason: string;
}

/**
 * The classification decision. `clean: true` means no PII was found; otherwise
 * `findings` is a non-empty list of located detections.
 */
export type PiiClassification =
  | { readonly clean: true; readonly findings: readonly [] }
  | { readonly clean: false; readonly findings: readonly PiiFinding[] };

/**
 * Anything the classifier can inspect: a bare string, a {@link MemoryRecord}, or
 * any plain object whose string / string-array properties should be scanned.
 * Nested objects and arrays are walked recursively, so PII buried in a
 * sub-object is still found; non-string leaf values (numbers, booleans, `null`)
 * are ignored, so a record's numeric `schemaVersion` or an ISO `createdAt`
 * timestamp never trips a false positive.
 */
export type PiiCandidate = string | MemoryRecord | Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

interface Detector {
  readonly kind: PiiKind;
  readonly reason: string;
  readonly pattern: RegExp;
  /** Optional extra guard to reject a syntactic match that is not real PII. */
  readonly accept?: (match: string) => boolean;
}

function luhnValid(digits: string): boolean {
  const only = digits.replace(/\D/g, "");
  if (only.length < 13 || only.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = only.length - 1; i >= 0; i--) {
    let n = only.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function validIpv4(match: string): boolean {
  return match.split(".").every((octet) => {
    const n = Number(octet);
    return octet.length <= 3 && n >= 0 && n <= 255;
  });
}

// Detectors run against the raw text. `pattern` MUST be global (`g`) so every
// occurrence is reported, not just the first.
const DETECTORS: readonly Detector[] = [
  {
    kind: "private-key",
    reason: "PEM private-key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    kind: "aws-access-key-id",
    reason: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: "jwt",
    reason: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    kind: "ssn",
    reason: "US Social Security Number",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    kind: "credit-card",
    reason: "credit-card number (Luhn-valid)",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    accept: luhnValid,
  },
  {
    kind: "phone",
    reason: "telephone number",
    // Optional country code, then 3-3-4 grouping with separators — deliberately
    // strict so ISO timestamps / ids (4-2-2, 3-1-1…) do not match.
    pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
  },
  {
    kind: "ip-address",
    reason: "IPv4 address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    accept: validIpv4,
  },
  {
    kind: "email",
    reason: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

// Obfuscated-email detector. Real-world PII is often written to evade naive
// scanners: `alice (at) example dot com`, `alice[at]example[dot]com`. We
// normalise those spellings back to `@`/`.` on a COPY of the text and re-run the
// plain email detector; a hit is reported at the original field. Because the
// MVP is no-PII by construction we accept the (safe) risk of flagging a benign
// "X at Y dot Z" phrase — a false positive is a rejected write, never a leak.
//
// The two obfuscation spellings are matched in ONE left-to-right pass (the `at`
// alternation first, then `dot`) so a normalised offset can be mapped straight
// back to the original text — a normalising `.replace()` chain would shift every
// offset after a rewritten run and mis-locate the finding.
const OBFUSCATION_TOKEN =
  /(\s*[([{]?\s*(?:at|@)\s*[)\]}]?\s*)|(\s*[([{]?\s*(?:dot|\.)\s*[)\]}]?\s*)/gi;

/**
 * Normalise obfuscated `@`/`.` spellings back to their canonical characters.
 * Returns the normalised text plus a `map` where `map[i]` is the index in the
 * ORIGINAL text that normalised character `i` originated from, so a match found
 * in the normalised copy can be reported at its true original offset.
 */
function deobfuscate(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let last = 0;
  OBFUSCATION_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null = OBFUSCATION_TOKEN.exec(text);
  while (m !== null) {
    for (let i = last; i < m.index; i++) {
      out += text[i];
      map.push(i);
    }
    out += m[1] !== undefined ? "@" : ".";
    map.push(m.index);
    last = m.index + m[0].length;
    if (m.index === OBFUSCATION_TOKEN.lastIndex) OBFUSCATION_TOKEN.lastIndex++;
    m = OBFUSCATION_TOKEN.exec(text);
  }
  for (let i = last; i < text.length; i++) {
    out += text[i];
    map.push(i);
  }
  return { text: out, map };
}

function redact(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 4) return "****";
  return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)}`;
}

function scanText(path: string, text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    let m: RegExpExecArray | null = detector.pattern.exec(text);
    while (m !== null) {
      const value = m[0];
      if (!detector.accept || detector.accept(value)) {
        findings.push({
          kind: detector.kind,
          path,
          index: m.index,
          excerpt: redact(value),
          reason: detector.reason,
        });
      }
      // Guard against zero-width matches looping forever.
      if (m.index === detector.pattern.lastIndex) detector.pattern.lastIndex++;
      m = detector.pattern.exec(text);
    }
  }

  // Obfuscated email pass — only add hits the plain pass did not already report.
  const { text: normalised, map } = deobfuscate(text);
  if (normalised !== text) {
    const emailDetector = DETECTORS.find((d) => d.kind === "email");
    if (emailDetector) {
      // Dedupe per LOCATION, not per field: a field-wide "already saw an email"
      // flag would drop every obfuscated hit as soon as one plain email exists
      // anywhere in the field (under-reporting a mixed plain+obfuscated field).
      const plainEmailIndices = new Set(
        findings.filter((f) => f.kind === "email").map((f) => f.index),
      );
      emailDetector.pattern.lastIndex = 0;
      let em: RegExpExecArray | null = emailDetector.pattern.exec(normalised);
      while (em !== null) {
        // Map the offset in the normalised copy back to the original text so the
        // finding is located where the obfuscated value actually is.
        const originalIndex = map[em.index] ?? em.index;
        if (!plainEmailIndices.has(originalIndex)) {
          findings.push({
            kind: "email",
            path,
            index: originalIndex,
            excerpt: redact(em[0]),
            reason: "obfuscated email address",
          });
        }
        if (em.index === emailDetector.pattern.lastIndex) emailDetector.pattern.lastIndex++;
        em = emailDetector.pattern.exec(normalised);
      }
    }
  }

  return findings;
}

/**
 * Flatten a candidate into the `(path, text)` fields the detectors scan. String
 * leaves are scanned; every object / array is walked RECURSIVELY so PII nested
 * inside sub-objects or arrays of objects cannot slip past the default-deny
 * guard as a false negative. Non-string, non-container leaves (numbers,
 * booleans, `null`) are ignored. A `WeakSet` breaks any accidental reference
 * cycle so a self-referential candidate cannot loop forever.
 */
function collectFields(candidate: PiiCandidate): Array<{ path: string; text: string }> {
  if (typeof candidate === "string") return [{ path: "", text: candidate }];
  const fields: Array<{ path: string; text: string }> = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      fields.push({ path, text: value });
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, path === "" ? `${i}` : `${path}.${i}`));
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      walk(v, path === "" ? key : `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(candidate)) {
    walk(value, key);
  }
  return fields;
}

/**
 * Classify a candidate for PII. PURE and deterministic — no I/O, no shared
 * state. Returns `{ clean: true }` when nothing is found, otherwise
 * `{ clean: false, findings }` with a located reason for every hit.
 *
 * Inspect a whole {@link MemoryRecord} (every string / string-array field is
 * scanned), a single field's text, or any plain object.
 */
export function classifyPii(candidate: PiiCandidate): PiiClassification {
  const findings: PiiFinding[] = [];
  for (const { path, text } of collectFields(candidate)) {
    findings.push(...scanText(path, text));
  }
  if (findings.length === 0) return { clean: true, findings: [] };
  return { clean: false, findings };
}

/** Convenience predicate: `true` when the candidate carries no detected PII. */
export function isPiiClean(candidate: PiiCandidate): boolean {
  return classifyPii(candidate).clean;
}
