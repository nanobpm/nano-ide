// Real-spec MCP projection conformance guard — the `check:mcp-conformance` CI gate
// (ADR 0067 · epic nanobpm/nano-ide#501, P2 #504).
//
// WHY THIS EXISTS
// `check:mcp` pins the projection over a minimal SYNTHETIC fixture; this gate holds the SAME
// projection to VENDORED, pinned, REAL consumer specs (nano-workforce first) — the surface where the
// `$ref`-body defect actually surfaced. For every projected tool it asserts self-containment (P0
// #502: no `$ref`, `body` explicitly typed) and faithful object-body transport (P1 #503: an object
// body round-trips, a pre-encoded string body is not double-encoded), reusing the exact projection
// and transport code, so a consumer spec that would project a broken tool fails the build here. It
// needs NO running instance — the vendored file is projected directly.
//
// Usage:  node --experimental-strip-types scripts/check-mcp-conformance.ts

import { runConsumerConformance } from "../src/runtime/mcp-conformance.ts";

const results = runConsumerConformance();
const failing = results.filter((r) => r.violations.length > 0);

if (failing.length > 0) {
  console.error("check:mcp-conformance: a real consumer spec would project a non-conformant MCP tool:\n");
  for (const { label, violations } of failing) {
    console.error(`  [${label}]`);
    for (const v of violations) console.error(`    ${v}`);
  }
  console.error(
    "\nEither the projection (packages/urban/src/openapi/spec.ts) or the offending consumer spec must be" +
      " fixed. See packages/urban/src/openapi/consumer-specs/README.md.",
  );
  process.exit(1);
}

const labels = results.map((r) => r.label).join(", ");
console.log(`check:mcp-conformance: ${results.length} consumer spec(s) project conformant MCP tools (${labels}).`);
