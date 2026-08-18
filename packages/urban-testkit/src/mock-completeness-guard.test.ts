// Derivation completeness guard for the mock layer (epic #296, S5) — the centrepiece.
//
// The mock layer's outcome inventory must never DRIFT from the engine's completion surface. This
// guard makes that structural, not aspirational: it derives the truth from the SOURCE TYPES and
// fails CI if a link in the chain is missing. Concretely it proves the chain
//
//     engine completion method  →  MockOutcome kind  →  MockWorkerBuilder method  →  a test
//
// is total: every engine completion method the mock resolves through has exactly one MockOutcome
// variant, `applyOutcome` handles exactly those variants, each variant is produced by at least one
// builder method, and each builder outcome method is exercised by at least one test. It also proves
// every `EngineJob` field a condition could match is reachable by a tested `when(...)` predicate.
//
// ## Why this makes "a new outcome without a mock" a red build
// Suppose the engine grows a fourth job-completion method:
//   • To resolve mocked jobs through it, it must be added to `OutcomeEngine` (the curated
//     completion-surface contract in `worker-mock.ts`). This guard asserts every `OutcomeEngine`
//     method is actually dispatched to inside `applyOutcome` — so a bare addition FAILS here until
//     `applyOutcome` handles it.
//   • `applyOutcome` switches exhaustively over `MockOutcome["kind"]`, so handling it requires a new
//     variant. This guard asserts the switch's case labels equal the union's kinds — a new engine
//     method with no matching kind FAILS here.
//   • This guard asserts every kind is produced by a `MockWorkerBuilder` method — a new kind with no
//     builder method FAILS here.
//   • This guard asserts every builder outcome method appears in a test — a new builder method with
//     no test FAILS here.
// So the only way to add an engine outcome and keep CI green is to wire it all the way through to a
// test — which is exactly the point. The guard reads real source files, so it cannot be satisfied
// by a stale hand-maintained list.
//
// Runs on Node and Deno (reads source via `node:fs`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Source loading (resolver-agnostic: try monorepo-relative then node_modules).
// ---------------------------------------------------------------------------------------------

function firstExisting(relatives: readonly string[], what: string): string {
  const tried: string[] = [];
  for (const rel of relatives) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`could not locate ${what}; tried:\n  ${tried.join("\n  ")}`);
}

function sibling(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

const workerMockSrc = sibling("worker-mock.ts");
const childMockSrc = sibling("child-process-mock.ts");
const hostSrc = firstExisting(
  [
    "../../urban/src/runtime/core/host.ts",
    "../../../node_modules/@nanobpm/urban/src/runtime/core/host.ts",
    "../node_modules/@nanobpm/urban/src/runtime/core/host.ts",
  ],
  "the EngineJob source (@nanobpm/urban runtime host.ts)",
);
const engineDts = firstExisting(
  [
    "../../../node_modules/@nanobpm/engine-wasm/readmodel/nanobpmn_engine.d.ts",
    "../node_modules/@nanobpm/engine-wasm/readmodel/nanobpmn_engine.d.ts",
  ],
  "the engine TestEngine type declaration",
);

/** Every `*.test.ts` in this package, concatenated — the corpus for "exercised by a test". */
function allTestSources(): string {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const names = readdirSync(dir).filter((n) => n.endsWith(".test.ts"));
  return names.map((n) => readFileSync(fileURLToPath(new URL(`./${n}`, import.meta.url)), "utf8")).join("\n");
}
// Tiny source extractors (regex/brace based — no TS compiler dependency).
// ---------------------------------------------------------------------------------------------

/** The substring of `source` from `startMarker` up to (excluding) the first blank line after it. */
function blockAfter(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected to find \`${startMarker}\``);
  const rest = source.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Balanced-brace body (including braces) of the first `{...}` after `signature`. */
function braceBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected to find \`${signature}\``);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `expected \`{\` after \`${signature}\``);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after \`${signature}\``);
}

function uniqueSorted(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

// =============================================================================================
// Derivations from the source of truth.
// =============================================================================================

/** (1) Engine completion methods the mock resolves through — the curated `OutcomeEngine` contract. */
function outcomeEngineMethods(): string[] {
  const body = braceBody(workerMockSrc, "export interface OutcomeEngine");
  return uniqueSorted(matchAll(body, /^\s*(\w+)\s*\(/gm));
}

/** (2) `MockOutcome` variant kinds, from the union declaration. */
function mockOutcomeKinds(): string[] {
  const block = blockAfter(workerMockSrc, "export type MockOutcome =");
  return uniqueSorted(matchAll(block, /kind:\s*"([^"]+)"/g));
}

/** (3) `applyOutcome`'s switch: `case "<kind>"` labels, and the `engine.<method>(` calls per case. */
function applyOutcomeShape(): { cases: string[]; engineCalls: string[] } {
  const body = braceBody(workerMockSrc, "export function applyOutcome");
  return {
    cases: uniqueSorted(matchAll(body, /case\s+"([^"]+)"/g)),
    engineCalls: uniqueSorted(matchAll(body, /engine\.(\w+)\s*\(/g)),
  };
}

/** (4) `MockWorkerBuilder` outcome methods → the `MockOutcome` kind(s) each produces (via `#add`). */
function builderOutcomeMethods(): Map<string, string[]> {
  const cls = braceBody(workerMockSrc, "export class MockWorkerBuilder");
  // Split the class into method chunks: a method head is an indented `name(` at 2-space indent.
  const heads = [...cls.matchAll(/\n  (?:async\s+)?([a-zA-Z]\w*)\s*\(/g)];
  const byMethod = new Map<string, string[]>();
  for (let i = 0; i < heads.length; i++) {
    const name = heads[i][1];
    const from = heads[i].index ?? 0;
    const to = i + 1 < heads.length ? (heads[i + 1].index ?? cls.length) : cls.length;
    const chunk = cls.slice(from, to);
    const kinds = matchAll(chunk, /#add\(\{\s*kind:\s*"([^"]+)"/g);
    if (kinds.length > 0) byMethod.set(name, uniqueSorted(kinds));
  }
  return byMethod;
}

/** (5) `EngineJob` field names, from the interface declaration. */
function engineJobFields(): string[] {
  const body = braceBody(hostSrc, "export interface EngineJob");
  // Field lines look like `jobKey: string;` / `variables: In;` / `elementId?: string;`.
  return uniqueSorted(matchAll(body, /^\s*(\w+)\??\s*:/gm));
}

/** Engine methods declared on the WASM `TestEngine` (used to verify OutcomeEngine is faithful). */
function testEngineMethods(): Set<string> {
  const body = braceBody(engineDts, "export class TestEngine");
  return new Set(matchAll(body, /^\s*(\w+)\s*\(/gm));
}

/** `job.<field>` references inside `.when( … )` predicate bodies across all tests. Captures the
 *  full balanced argument of each `.when(` call (so multi-line block-body predicates are covered),
 *  reads the predicate's parameter name, then collects every `${param}.${field}` access. */
function fieldsReachableByWhen(): Set<string> {
  const tests = allTestSources();
  const reachable = new Set<string>();
  const marker = ".when(";
  let idx = tests.indexOf(marker);
  while (idx !== -1) {
    const open = idx + marker.length - 1; // index of the `(`
    let depth = 0;
    let end = open;
    for (let i = open; i < tests.length; i++) {
      if (tests[i] === "(") depth++;
      else if (tests[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    const arg = tests.slice(open + 1, end);
    const param = /^\s*\(?\s*(\w+)/.exec(arg)?.[1];
    if (param) {
      for (const f of arg.matchAll(new RegExp(`\\b${param}\\.(\\w+)`, "g"))) reachable.add(f[1]);
    }
    idx = tests.indexOf(marker, end + 1);
  }
  return reachable;
}

// =============================================================================================
// The guard.
// =============================================================================================

test("completeness: OutcomeEngine names only methods that exist on the real TestEngine", () => {
  const engineMethods = testEngineMethods();
  for (const m of outcomeEngineMethods()) {
    assert.ok(
      engineMethods.has(m),
      `OutcomeEngine.${m} must be a real TestEngine completion method — the mock's completion ` +
        `contract has drifted from the engine (@nanobpm/engine-wasm). Found engine methods: ` +
        `${[...engineMethods].sort().join(", ")}`,
    );
  }
  assert.ok(outcomeEngineMethods().length >= 3, "expected at least completeJob/failJob/throwError");
});

test("completeness: applyOutcome dispatches to EXACTLY the OutcomeEngine completion methods", () => {
  const declared = outcomeEngineMethods();
  const { engineCalls } = applyOutcomeShape();
  assert.deepEqual(
    engineCalls,
    declared,
    "every engine completion method the mock declares must be dispatched by applyOutcome, and vice " +
      "versa. A method added to OutcomeEngine (because the engine grew a completion method) that " +
      "applyOutcome does not call — or a stray call — is drift and fails here.",
  );
});

test("completeness: applyOutcome's switch cases equal the MockOutcome kinds (source-level exhaustive)", () => {
  const kinds = mockOutcomeKinds();
  const { cases } = applyOutcomeShape();
  assert.ok(kinds.length >= 3, "expected at least complete/fail/throwError kinds");
  assert.deepEqual(
    cases,
    kinds,
    "applyOutcome must handle exactly the MockOutcome variants — mirrors the compile-time `never` " +
      "exhaustiveness guard at the source level, so a new kind without a case fails here too.",
  );
});

test("completeness: every engine completion method maps 1:1 to a distinct MockOutcome kind", () => {
  // The mock models exactly one outcome variant per engine completion method (incidents are a mode
  // of `fail`, not a fourth method). So #kinds === #engine-methods and the mapping is a bijection.
  const methods = outcomeEngineMethods();
  const kinds = mockOutcomeKinds();
  assert.equal(
    kinds.length,
    methods.length,
    `expected one MockOutcome kind per engine completion method (${methods.length}), got ` +
      `${kinds.length} kinds (${kinds.join(", ")}). Adding an engine completion method requires a ` +
      `new MockOutcome variant.`,
  );
});

test("completeness: every MockOutcome kind is produced by at least one MockWorkerBuilder method", () => {
  const produced = new Set<string>();
  for (const kinds of builderOutcomeMethods().values()) for (const k of kinds) produced.add(k);
  for (const kind of mockOutcomeKinds()) {
    assert.ok(
      produced.has(kind),
      `MockOutcome kind "${kind}" has no MockWorkerBuilder method producing it — a new outcome kind ` +
        `must come with a builder method (completeWith/failWith/throwBpmnError/raiseIncident/…).`,
    );
  }
});

test("completeness: every MockWorkerBuilder outcome method is exercised by at least one test", () => {
  const tests = allTestSources();
  const methods = [...builderOutcomeMethods().keys()];
  assert.ok(methods.length >= 4, `expected ≥4 builder outcome methods, found: ${methods.join(", ")}`);
  for (const method of methods) {
    assert.ok(
      new RegExp(`\\.${method}\\s*\\(`).test(tests),
      `MockWorkerBuilder.${method}() is never exercised by any *.test.ts — a mock outcome without a ` +
        `test is exactly the gap this guard fails on. Add a Red/Green test driving .${method}().`,
    );
  }
});

test("completeness: every EngineJob field is reachable by a tested when(...) predicate", () => {
  const fields = engineJobFields();
  const reachable = fieldsReachableByWhen();
  assert.ok(fields.length >= 4, `expected ≥4 EngineJob fields, found: ${fields.join(", ")}`);
  for (const field of fields) {
    assert.ok(
      reachable.has(field),
      `EngineJob.${field} is not matched by any tested \`when(job => job.${field}…)\` predicate — a ` +
        `new matchable condition field must come with a predicate + test. Fields reached by tests: ` +
        `${[...reachable].sort().join(", ")}`,
    );
  }
});

test("completeness: the child-process builder reuses the shared MockOutcome kinds (no second model)", () => {
  // S3 must not invent a parallel outcome model. Its builder methods must produce only kinds that
  // exist in the shared MockOutcome union, and it must import (not redefine) MockOutcome.
  assert.ok(
    /import\s+type\s*\{[^}]*\bMockOutcome\b[^}]*\}\s*from\s*"\.\/worker-mock\.ts"/.test(childMockSrc),
    "child-process-mock.ts must import MockOutcome from ./worker-mock.ts (derivation over duplication)",
  );
  const kinds = new Set(mockOutcomeKinds());
  const childKinds = matchAll(childMockSrc, /#set\(\{\s*kind:\s*"([^"]+)"/g);
  assert.ok(childKinds.length >= 2, `expected the child-process builder to set ≥2 outcomes, got ${childKinds.length}`);
  for (const k of childKinds) {
    assert.ok(kinds.has(k), `child-process builder produces kind "${k}" that is not a shared MockOutcome variant`);
  }
});

test("completeness: the full derivation chain is documented and non-vacuous", () => {
  // Guard-the-guard: prove the extractors returned real, non-empty data so none of the assertions
  // above passed vacuously (e.g. a renamed symbol yielding an empty set that trivially satisfies a
  // `for` loop).
  assert.deepEqual(outcomeEngineMethods(), ["completeJob", "failJob", "throwError"], "engine completion surface");
  assert.deepEqual(mockOutcomeKinds(), ["complete", "fail", "throwError"], "MockOutcome kinds");
  const builders = builderOutcomeMethods();
  for (const expected of ["completeWith", "failWith", "throwBpmnError", "raiseIncident"]) {
    assert.ok(builders.has(expected), `expected builder method ${expected} to be discovered`);
  }
  const fields = engineJobFields();
  for (const expected of ["jobKey", "jobType", "processInstanceKey", "elementId", "variables"]) {
    assert.ok(fields.includes(expected), `expected EngineJob field ${expected} to be discovered`);
  }
});
