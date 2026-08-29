// Spec↔tool parity guard (ADR 0067 Slice 3) — the `check:mcp` CI drift gate.
//
// WHY THIS EXISTS
// The MCP tool surface is DERIVED from the OpenAPI spec by the single walker in
// `src/openapi/spec.ts` (`collectOperations` → `collectMcpToolProjection`). A
// silent change to that projection — an operation that starts/stops being a
// tool, flips read↔mutating, or gains/loses its `x-mcp` exclusion — is a
// SECURITY-relevant surface change (it can expose an operator-only door to an
// agent, or drop a guard). This guard captures the projection as a committed
// artifact (`mcp-tools.snapshot.json`) and fails CI on any drift, exactly like
// the repo's other "generated derived artifact + fail-on-drift" gates
// (`check:runtime`). It reuses `diffMcpToolProjection` (unit-tested with an
// injected skew) so the human-readable drift report is the same code CI runs.
//
// Usage:  node --experimental-strip-types scripts/gen-mcp-tools.ts [--check]
//   (default) regenerate src/openapi/mcp-tools.snapshot.json from the fixture
//   --check   exit non-zero if the committed snapshot is stale (for CI); no write

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collectMcpToolProjection,
  diffMcpToolProjection,
  findAllToolSchemaViolations,
  type McpToolProjection,
  parseSpec,
} from "../src/openapi/spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../src/openapi/mcp-parity.fixture.yaml");
const SNAPSHOT = resolve(HERE, "../src/openapi/mcp-tools.snapshot.json");

function doc() {
  return parseSpec(readFileSync(FIXTURE, "utf8"));
}

function project(): McpToolProjection[] {
  return collectMcpToolProjection(doc());
}

function serialize(projection: McpToolProjection[]): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

/** Every projected tool must expose a self-contained input schema: no unresolved `$ref` (an MCP
 *  client cannot follow `#/components/...`) and an explicit `type` on `body`. This runs on BOTH
 *  regenerate and `--check`, so a fixture that would ship an opaque tool schema fails loudly instead
 *  of being written into the snapshot (ADR 0067). */
function assertSelfContained(): void {
  const violations = findAllToolSchemaViolations(doc());
  if (violations.length > 0) {
    console.error(
      "check:mcp: a projected MCP tool input schema is not self-contained:\n" +
        violations.map((line) => `  ${line}`).join("\n") +
        "\n\nResolve the offending component `$ref`(s) in the projection (openapi/spec.ts).",
    );
    process.exit(1);
  }
}

const check = process.argv.includes("--check");
const current = project();

assertSelfContained();

if (check) {
  let committed: McpToolProjection[];
  try {
    committed = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch (e) {
    console.error(
      `check:mcp: cannot read ${SNAPSHOT} (${e instanceof Error ? e.message : String(e)}) — run \`npm run gen:mcp-tools -w packages/urban\``,
    );
    process.exit(1);
  }
  const drift = diffMcpToolProjection(committed, current);
  if (drift.length > 0) {
    console.error(
      "check:mcp: OpenAPI spec ↔ projected MCP tool list are out of parity:\n" +
        drift.map((line) => `  ${line}`).join("\n") +
        "\n\nRegenerate + commit with `npm run gen:mcp-tools -w packages/urban`.",
    );
    process.exit(1);
  }
  console.log("check:mcp: spec ↔ MCP tool projection in parity.");
} else {
  writeFileSync(SNAPSHOT, serialize(current));
  console.log(`gen:mcp-tools: wrote ${SNAPSHOT}`);
}
