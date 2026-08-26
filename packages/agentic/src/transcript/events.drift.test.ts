// Drift-guard: exactly ONE parser of the transcript log (ADR 0056, #251).
//
// This enforces structurally — by scanning the package source — that the raw-chunk → typed-event
// classification lives in exactly one module (`transcript/events.ts`), so a second, divergent parser of
// the same bytes cannot creep in. The whole point of the event-sourced model is "the log IS the state":
// every view derives from the one fold, none re-parses the bytes itself. A sibling cockpit task imports
// the `TRANSCRIPT_EVENT_MARKER` IDENTIFIER (never the string literal), so this guard stays satisfied as
// consumers grow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSCRIPT_EVENT_MARKER } from "./events.ts";

const TRANSCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = dirname(TRANSCRIPT_DIR);

/** Every non-test `.ts` source file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const PARSER_MODULE = join(TRANSCRIPT_DIR, "events.ts");
const STORE_MODULE = join(TRANSCRIPT_DIR, "store.ts");

test("the transcript-event marker literal is DEFINED in exactly one module (no second parser)", () => {
  // Consumers reference the marker via the imported `TRANSCRIPT_EVENT_MARKER` identifier; only the ONE
  // parser embeds the marker's string literal. A second module hardcoding it would be a second parser.
  // Match every quote form (double, single, backtick) so a second parser can't bypass the guard by
  // hardcoding the marker in a different literal style. Scan the WHOLE package src so no module anywhere
  // (cockpit, protocol, …) can inline a private copy of the marker.
  const quotedMarkerForms = ['"', "'", "`"].map((q) => `${q}${TRANSCRIPT_EVENT_MARKER}${q}`);
  const owners = sourceFiles(SRC_DIR).filter((path) => {
    const src = readFileSync(path, "utf8");
    return quotedMarkerForms.some((literal) => src.includes(literal));
  });
  assert.deepEqual(
    owners,
    [PARSER_MODULE],
    `the marker literal must be defined only in ${relative(SRC_DIR, PARSER_MODULE)}; found in: ${owners
      .map((p) => relative(SRC_DIR, p))
      .join(", ")}`,
  );
});

test("no transcript consumer re-parses raw chunks — JSON.parse of the log lives only in the parser", () => {
  // Every projection must fold through the single parser, never JSON.parse a chunk itself. Scan every
  // non-test transcript module EXCEPT the parser (which owns the one JSON.parse) and the store (whose
  // JSON handling is DB rows, not the log), and assert none of them contains a raw JSON.parse. Scanning
  // the whole plane (not a name pattern) means a future consumer module is guarded the moment it is added.
  const consumers = sourceFiles(TRANSCRIPT_DIR).filter(
    (path) => path !== PARSER_MODULE && path !== STORE_MODULE,
  );
  for (const path of consumers) {
    const src = readFileSync(path, "utf8");
    assert.ok(
      !src.includes("JSON.parse"),
      `${relative(SRC_DIR, path)} must derive through parseTranscriptEvent, not re-parse the log itself`,
    );
  }
});
