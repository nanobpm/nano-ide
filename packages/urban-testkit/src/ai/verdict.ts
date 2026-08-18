// Chat-verdict contract shared by the fake judge and S3's parser (issue #297, slice S1).
//
// The chat seam returns free text; the judge layer needs a structured pass/fail verdict.
// This is the single canonical serialize/parse pair so the fake's output and S3's parser
// never drift (AGENTS.md: derivation over duplication).

/** A structured judge verdict. */
export interface ChatVerdict {
  readonly pass: boolean;
  readonly rationale: string;
}

/** Serializes a verdict to the canonical JSON text a chat adapter returns. */
export function serializeVerdict(verdict: ChatVerdict): string {
  return JSON.stringify({ pass: verdict.pass, rationale: verdict.rationale });
}

function isVerdictShape(value: unknown): value is ChatVerdict {
  return (
    typeof value === "object" &&
    value !== null &&
    "pass" in value &&
    "rationale" in value &&
    typeof value.pass === "boolean" &&
    typeof value.rationale === "string"
  );
}

/**
 * Parses canonical verdict JSON. Throws loudly on malformed/mismatched text rather than
 * silently defaulting — a corrupted verdict must never be read as a pass.
 */
export function parseVerdict(text: string): ChatVerdict {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new Error(`chat verdict is not valid JSON: ${text}`, { cause });
  }
  if (!isVerdictShape(decoded)) {
    throw new Error(`chat verdict is missing the { pass, rationale } shape: ${text}`);
  }
  return { pass: decoded.pass, rationale: decoded.rationale };
}
