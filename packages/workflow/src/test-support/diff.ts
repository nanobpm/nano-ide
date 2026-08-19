// A legible red/green structural diff between two canonical models. Each of the
// three sections (flow nodes, sequence flows, message subscriptions) is compared
// as a MULTISET: a line present more times on one side than the other is
// reported, `-` (red) for "expected / golden only" and `+` (green) for "derived
// only". Equal models produce an empty diff.

import type { CanonicalModel } from "./normalize.js";

const useColor = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout?.isTTY);
};

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function paint(code: string, s: string): string {
  return useColor() ? `${code}${s}${RESET}` : s;
}

/** Multiset difference: for each distinct line, the count on `expected` minus the
 *  count on `actual`. Positive → missing from `actual` (removed); negative →
 *  extra in `actual` (added). */
function multisetDiff(expected: string[], actual: string[]): { removed: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const line of expected) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of actual) counts.set(line, (counts.get(line) ?? 0) - 1);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of counts) {
    for (let k = 0; k < n; k++) removed.push(line);
    for (let k = 0; k < -n; k++) added.push(line);
  }
  return { removed: removed.sort(), added: added.sort() };
}

function section(title: string, expected: string[], actual: string[]): string[] {
  const { removed, added } = multisetDiff(expected, actual);
  if (removed.length === 0 && added.length === 0) return [];
  const out = [paint(DIM, `  ${title}:`)];
  for (const line of removed) out.push(paint(RED, `    - ${line}`));
  for (const line of added) out.push(paint(GREEN, `    + ${line}`));
  return out;
}

/** True when two canonical models are structurally equal (all three multisets
 *  match). */
export function modelsEqual(expected: CanonicalModel, actual: CanonicalModel): boolean {
  return diffModels(expected, actual) === "";
}

/** Render a legible red/green structural diff, or `""` when the two models are
 *  structurally equal. `-`/red is the `expected` (golden) side, `+`/green the
 *  `actual` (derived) side. */
export function diffModels(expected: CanonicalModel, actual: CanonicalModel): string {
  const lines = [
    ...section("flow nodes", expected.nodes, actual.nodes),
    ...section("sequence flows", expected.flows, actual.flows),
    ...section("message subscriptions", expected.messages, actual.messages),
  ];
  if (lines.length === 0) return "";
  return [
    paint(DIM, "structural mismatch (-expected/golden, +actual/derived):"),
    ...lines,
  ].join("\n");
}
