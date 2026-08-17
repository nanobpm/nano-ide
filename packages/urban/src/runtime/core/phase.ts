// phase — the framework-level *domain phase* primitive (issue #266).
//
// A running process today exposes only engine status (`ACTIVE`/`TERMINATED`) and whatever
// terminal status an app reconciles. The *domain* lifecycle — "which phase is this instance
// in?" — is latent in the model (every BPMN element sits in exactly one enclosing scope:
// `process ⊃ subProcess ⊃ activity`) but is not reified anywhere. Apps hand-wire it, or don't.
// This module derives it by convention, with ZERO model declaration required, from two things
// urban already has: the deployed model's element→scope containment, and the furthest/active
// `element_id` per instance recorded in `_urban_write_provenance`.
//
// A three-tier ladder (most-specific wins):
//
//   - Tier 0 — structural (default, zero declaration): phase = the breadcrumb of enclosing
//     NAMED scopes down to the current element (`plan-fanout › Implement task`), derived from
//     the containment hierarchy + provenance. Always available.
//   - Tier 1 — optional explicit override: a model MAY annotate `nano:phase` (as a `nano:phase`
//     attribute on the element/scope, or a `zeebe:property name="nano:phase"` in its
//     `extensionElements`) to rename, group, or insert a phase where structure alone is wrong
//     or too fine/coarse. Never required; overrides the structural label for that scope/element.
//   - Tier 2 — cross-instance rollup: lineage (`_urban.lineage` / `buildLineageTree`, #254)
//     stitches child instances; each contributes its structurally-derived phase and the
//     parent/epic phase is the *frontier* of that tree (the most-recently-advanced contributor).
//
// This file is intentionally `node:*`-free (the host contract) and pure/deterministic — a read
// projection, exactly like {@link ./lineage.ts}. It shares nothing with the engine and can run
// anywhere the model XML + provenance rows are available.

import type { LineageNode, LineageTree } from "./lineage.ts";

/** The BPMN local-names urban treats as *scope containers* — the enclosing scopes whose names
 *  become coarse phases. Namespace prefixes (e.g. `bpmn:`) are stripped before matching, so any
 *  prefix works. A `process` is the root scope; `subProcess`/`adHocSubProcess`/`transaction` are
 *  the nestable intermediate scopes a modeller wraps related activities in (and whose name then
 *  becomes the phase automatically — "declaring a phase" collapses into *naming a scope you
 *  already have"). */
export const SCOPE_CONTAINERS: readonly string[] = [
  "process",
  "subProcess",
  "adHocSubProcess",
  "transaction",
];

/** The kind of a breadcrumb crumb: the root `process`, an intermediate `subProcess`-family
 *  scope, or the leaf `element` (the flow node the token furthest reached). */
export type CrumbKind = "process" | "subProcess" | "element";

/** Where a crumb's label came from: the model's structure (a scope/element `name`, or an
 *  id/type fallback when unnamed), or an explicit `nano:phase` override (Tier 1). */
export type CrumbSource = "structural" | "override";

/** One crumb of a phase breadcrumb — a single enclosing scope, or the leaf element. */
export interface PhaseCrumb {
  /** The BPMN element id of the scope/element this crumb represents. */
  readonly id: string;
  /** The BPMN local-name (namespace prefix stripped), e.g. `process`, `subProcess`, `serviceTask`. */
  readonly type: string;
  /** Whether this crumb is the root process, an intermediate scope, or the leaf element. */
  readonly kind: CrumbKind;
  /** The display label: the `nano:phase` override if present, else the `name`, else an
   *  id/type fallback so a crumb is never blank. */
  readonly label: string;
  /** Whether {@link label} came from structure or an explicit override. */
  readonly source: CrumbSource;
}

/** Chosen granularity for the single-value `label` of a {@link Phase}:
 *  - `subProcess` — always the coarse (outermost meaningful scope) label.
 *  - `element` — always the fine (leaf element) label.
 *  - `auto` (default) — the coarse label when the element is inside a subProcess-family scope,
 *    else the fine element label ("subProcess-then-element"). */
export type PhaseGranularity = "subProcess" | "element" | "auto";

/** A derived domain phase for a single point in a process (the element a token reached). */
export interface Phase {
  /** The element the phase was derived for (the furthest/active flow node). */
  readonly elementId: string;
  /** The enclosing process's id/name (the root crumb's label), for context. */
  readonly process: string;
  /** The coarse phase: the outermost meaningful scope — the top-level `subProcess` label when the
   *  element is inside one, else the process label. */
  readonly coarse: string;
  /** The fine phase: the leaf element's label. */
  readonly fine: string;
  /** The single-value phase for the requested {@link PhaseGranularity}. */
  readonly label: string;
  /** The full ordered breadcrumb, outermost process → … → leaf element. A UI can render at any
   *  granularity it picks — roll up to a scope, or drill to the task — all derived. */
  readonly breadcrumb: readonly PhaseCrumb[];
}

/** Options for {@link derivePhase} / {@link deriveInstancePhases}. */
export interface DerivePhaseOptions {
  /** Which granularity the single-value {@link Phase.label} reports. Default `auto`. */
  readonly granularity?: PhaseGranularity;
}

/** The parsed structural view of one deployed model: every element's id/type/name/override plus
 *  its chain of enclosing scope ids (outermost → innermost). Build once per deployed model with
 *  {@link buildScopeIndex}; derive many instances' phases against it. */
export interface ScopeIndex {
  /** The process's own element (its id is the `bpmnProcessId`). Undefined for a fragment with no
   *  `process` element. */
  readonly process?: ScopeElement;
  /** Every id-bearing element (scopes and flow nodes), keyed by element id. */
  readonly elements: ReadonlyMap<string, ScopeElement>;
}

/** One id-bearing element parsed from a model: its identity plus its enclosing-scope chain. */
export interface ScopeElement {
  readonly id: string;
  /** BPMN local-name (prefix stripped), e.g. `process`, `subProcess`, `serviceTask`. */
  readonly type: string;
  /** The element's `name` attribute, if any. */
  readonly name?: string;
  /** An explicit `nano:phase` override for this element/scope, if declared. */
  readonly phaseOverride?: string;
  /** True when {@link type} is one of {@link SCOPE_CONTAINERS}. */
  readonly isScope: boolean;
  /** Ids of the enclosing scope containers, outermost (process) → innermost, NOT including this
   *  element itself. */
  readonly scopeChain: readonly string[];
}

/** A provenance row (subset) as recorded in `_urban_write_provenance`: which element of which
 *  instance wrote a row, and the monotonic `seq`/`at` that order progress. Only these fields are
 *  read; the join keys (`source`/`table_name`/`pk_value`) are irrelevant to phase derivation. */
export interface ProvenanceProgressRow {
  readonly instance_key: string | null;
  readonly element_id: string | null;
  readonly seq: number;
  readonly at?: string | null;
}

/** The furthest point one instance reached: its most-advanced element and the ordering keys. */
export interface FurthestReached {
  readonly instanceKey: string;
  readonly elementId: string;
  readonly seq: number;
  readonly at?: string;
}

/** A single instance's derived phase together with the progress keys that order it against
 *  siblings for the Tier-2 lineage rollup. */
export interface InstancePhase {
  readonly instanceKey: string;
  readonly phase: Phase;
  /** The provenance `seq` of the furthest write — monotonic within an instance. */
  readonly seq?: number;
  /** The provenance `at` timestamp of the furthest write (ISO-8601). */
  readonly at?: string;
}

// --- BPMN scanning helpers (regex, matching the toolkit derivers' approach) -------------------

/** Strip a namespace prefix from a tag/attribute local-name (`bpmn:subProcess` → `subProcess`). */
function localName(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

/** Read an attribute value from a start-tag's attribute text. Matches either an unprefixed name
 *  or any-prefixed local-name (so `name=` and `nano:phase`/`x:phase` both resolve), preferring an
 *  exact match. Returns undefined when absent. */
function attr(attrsText: string, name: string): string | undefined {
  const exact = attrsText.match(new RegExp(`(?:^|\\s)${escapeRe(name)}\\s*=\\s*"([^"]*)"`));
  if (exact) return decodeXml(exact[1]);
  const local = attrsText.match(new RegExp(`(?:^|\\s)[\\w.-]*:${escapeRe(name)}\\s*=\\s*"([^"]*)"`));
  return local ? decodeXml(local[1]) : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Decode the five predefined XML entities so labels read as authored. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extract a `nano:phase` override from a start-tag's own attributes: a namespace-prefixed
 *  `*:phase` attribute (e.g. `nano:phase`, prefix-agnostic). A bare, unprefixed `phase="…"`
 *  attribute is intentionally NOT matched — the override contract is a namespaced attribute, and
 *  matching bare `phase` would broaden it and risk colliding with unrelated attributes. Returns
 *  undefined when absent. */
function phaseAttr(attrsText: string): string | undefined {
  const m = attrsText.match(/(?:^|\s)[\w.-]+:phase\s*=\s*"([^"]*)"/);
  if (m == null) return undefined;
  const v = decodeXml(m[1]);
  return v.length > 0 ? v : undefined;
}

/** A mutable frame on the element-nesting stack during {@link buildScopeIndex}. */
interface Frame {
  id?: string;
  type: string;
  name?: string;
  isScope: boolean;
  phaseOverride?: string;
  /** Ids of enclosing scope containers, outermost → innermost, at the moment this frame opened. */
  scopeChain: string[];
}

/**
 * Parse one BPMN document into a {@link ScopeIndex}: the element→enclosing-scope containment plus
 * each element's name and optional `nano:phase` override. Pure and deterministic. Namespace
 * prefixes are ignored (matched by local-name), so `bpmn:`/`camunda:`/unprefixed all parse.
 *
 * The scan walks tags maintaining an element-nesting stack, so containment is exact even for
 * deeply nested `subProcess`es. Scope-container frames (see {@link SCOPE_CONTAINERS}) contribute
 * to the `scopeChain`; every id-bearing element is recorded. A `zeebe:property name="nano:phase"`
 * encountered inside an element's `extensionElements` attaches its override to the nearest
 * enclosing id-bearing element (the scope/flow node it decorates).
 *
 * Exception to prefix-agnostic parsing: the `<zeebe:property>` phase-override detection matches the
 * literal `zeebe:` prefix (not by local-name), so a model that binds the Zeebe namespace to a
 * different prefix will not be detected. This is deliberate — it mirrors the rest of the toolkit's
 * `<zeebe:property …>` scans and prevents unrelated `<bpmn:property>` data elements from
 * masquerading as phase overrides. (The `nano:phase` start-tag attribute remains prefix-agnostic.)
 */
export function buildScopeIndex(xml: string): ScopeIndex {
  const elements = new Map<string, ScopeElement>();
  let process: ScopeElement | undefined;

  const stack: Frame[] = [];
  const scopeIds: string[] = [];

  // Match every tag: `<name …>`, `<name …/>`, or `</name>`. Comments/CDATA/PIs are skipped.
  const tagRe = /<(\/)?([\w.:-]+)\b([^>]*?)(\/)?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;

  const record = (frame: Frame): void => {
    if (frame.id == null) return;
    const el: ScopeElement = {
      id: frame.id,
      type: frame.type,
      isScope: frame.isScope,
      scopeChain: [...frame.scopeChain],
      ...(frame.name != null ? { name: frame.name } : {}),
      ...(frame.phaseOverride != null ? { phaseOverride: frame.phaseOverride } : {}),
    };
    elements.set(el.id, el);
    if (el.type === "process" && process === undefined) process = el;
  };

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    // Non-tag matches (comment/CDATA/PI) have no captured name — skip.
    const name = m[2];
    if (name == null) continue;
    const isClose = m[1] === "/";
    const attrsText = m[3] ?? "";
    const selfClose = m[4] === "/";
    const type = localName(name);

    if (isClose) {
      // Close the nearest open frame of this type (tolerant of imperfect nesting).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type === type) {
          const closed = stack.splice(i, 1)[0];
          if (closed.isScope && closed.id != null) {
            const idx = scopeIds.lastIndexOf(closed.id);
            if (idx !== -1) scopeIds.splice(idx, 1);
          }
          record(closed);
          break;
        }
      }
      continue;
    }

    // A `zeebe:property name="nano:phase" value="…"` inside an `extensionElements` block decorates
    // the nearest open id-bearing element. Match only the `zeebe:` prefix inside `extensionElements`
    // (matching the rest of the toolkit's `<zeebe:property …>` scans) so unrelated `<bpmn:property>`
    // data elements can never masquerade as a phase override.
    if (
      name.startsWith("zeebe:") &&
      type === "property" &&
      stack.some((f) => f.type === "extensionElements")
    ) {
      const propName = attr(attrsText, "name");
      if (propName === "nano:phase") {
        const value = attr(attrsText, "value");
        if (value != null && value.length > 0) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].id != null) {
              stack[i].phaseOverride = value;
              break;
            }
          }
        }
      }
      // A property tag never opens a scope; if it is a container it still self-closes below.
    }

    const id = attr(attrsText, "id");
    const nameAttr = attr(attrsText, "name");
    const phaseOverride = phaseAttr(attrsText);
    const isScope = SCOPE_CONTAINERS.includes(type);
    const frame: Frame = {
      type,
      isScope,
      scopeChain: [...scopeIds],
      ...(id != null ? { id } : {}),
      ...(nameAttr != null ? { name: nameAttr } : {}),
      ...(phaseOverride != null ? { phaseOverride } : {}),
    };

    if (selfClose) {
      // A self-closing element never encloses anything; record it in place.
      record(frame);
      continue;
    }

    if (isScope && frame.id != null) scopeIds.push(frame.id);
    stack.push(frame);
  }

  // Record any frames left open by a truncated/malformed document, so nothing is silently lost.
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame) record(frame);
  }

  return { elements, ...(process != null ? { process } : {}) };
}

/** Resolve a crumb's label: override wins, else `name`, else an id/type fallback so it is never
 *  blank. Reports the source so a UI can distinguish an authored phase from a structural one. */
function crumbLabel(el: ScopeElement): { label: string; source: CrumbSource } {
  if (el.phaseOverride != null && el.phaseOverride.length > 0) {
    return { label: el.phaseOverride, source: "override" };
  }
  if (el.name != null && el.name.length > 0) return { label: el.name, source: "structural" };
  return { label: el.id, source: "structural" };
}

function crumbKind(el: ScopeElement): CrumbKind {
  if (el.type === "process") return "process";
  return el.isScope ? "subProcess" : "element";
}

/**
 * Derive the {@link Phase} for a single element against a {@link ScopeIndex}. Tier 0 (structural)
 * with Tier 1 (`nano:phase`) overrides folded in per crumb. Returns undefined when `elementId` is
 * not in the index (an unknown/foreign element).
 *
 * The breadcrumb is the chain of enclosing scopes (outermost process → innermost subProcess)
 * followed by the element itself. `coarse` is the outermost meaningful scope — the TOP-LEVEL
 * subProcess (the one directly under the process) when the element is inside a subProcess, else
 * the process. `fine` is the leaf element. `label` picks one per {@link PhaseGranularity}.
 */
export function derivePhase(
  index: ScopeIndex,
  elementId: string,
  options: DerivePhaseOptions = {},
): Phase | undefined {
  const el = index.elements.get(elementId);
  if (!el) return undefined;

  const breadcrumb: PhaseCrumb[] = [];
  for (const scopeId of el.scopeChain) {
    const scope = index.elements.get(scopeId);
    if (!scope) continue;
    const { label, source } = crumbLabel(scope);
    breadcrumb.push({ id: scope.id, type: scope.type, kind: crumbKind(scope), label, source });
  }
  // The element itself is always the leaf crumb. `scopeChain` holds only the ENCLOSING scopes —
  // each frame captures the open scope ids before pushing its own (see buildScopeIndex), so an
  // element is never in its own chain. Thus even when the element is itself a scope/process, it is
  // appended exactly once here as its own leaf; there is no duplicate to guard against.
  {
    const { label, source } = crumbLabel(el);
    breadcrumb.push({ id: el.id, type: el.type, kind: crumbKind(el), label, source });
  }

  const processCrumb = breadcrumb.find((c) => c.kind === "process");
  // The top-level subProcess = the first `subProcess`-family crumb (outermost, directly under the
  // process). That is the "outermost meaningful scope" the coarse phase reports.
  const topSubProcess = breadcrumb.find((c) => c.kind === "subProcess");
  const leaf = breadcrumb[breadcrumb.length - 1];

  const coarse = (topSubProcess ?? processCrumb ?? leaf).label;
  const fine = leaf.label;

  const granularity = options.granularity ?? "auto";
  let label: string;
  if (granularity === "subProcess") label = coarse;
  else if (granularity === "element") label = fine;
  else label = topSubProcess ? coarse : fine;

  return {
    elementId,
    process: processCrumb?.label ?? el.id,
    coarse,
    fine,
    label,
    breadcrumb,
  };
}

/**
 * Collapse provenance rows to the furthest point each instance reached — the row with the greatest
 * `seq` per `instance_key` (monotonic within an instance). Rows with a null `instance_key` or
 * `element_id` are ignored (a write outside a job records no element). Deterministic.
 */
export function furthestReached(rows: readonly ProvenanceProgressRow[]): Map<string, FurthestReached> {
  const out = new Map<string, FurthestReached>();
  for (const r of rows) {
    if (r.instance_key == null || r.element_id == null) continue;
    const prev = out.get(r.instance_key);
    if (!prev || r.seq > prev.seq) {
      out.set(r.instance_key, {
        instanceKey: r.instance_key,
        elementId: r.element_id,
        seq: r.seq,
        ...(r.at != null ? { at: r.at } : {}),
      });
    }
  }
  return out;
}

/**
 * The Phase-1 read projection: derive each instance's domain phase from a deployed model's
 * {@link ScopeIndex} and the model's `_urban_write_provenance` rows. Combines {@link furthestReached}
 * (furthest element per instance) with {@link derivePhase}. Instances whose furthest element is not
 * in this model's index are skipped (they belong to another deployed model). Pure and deterministic.
 */
export function deriveInstancePhases(
  index: ScopeIndex,
  rows: readonly ProvenanceProgressRow[],
  options: DerivePhaseOptions = {},
): Map<string, InstancePhase> {
  const out = new Map<string, InstancePhase>();
  for (const f of furthestReached(rows).values()) {
    const phase = derivePhase(index, f.elementId, options);
    if (!phase) continue;
    out.set(f.instanceKey, {
      instanceKey: f.instanceKey,
      phase,
      seq: f.seq,
      ...(f.at != null ? { at: f.at } : {}),
    });
  }
  return out;
}

/** The Tier-2 rollup: the epic/parent phase (the *frontier* of the lineage tree) plus every
 *  contributing instance's phase. */
export interface LineagePhaseRollup {
  readonly rootRequestKey: string;
  /** The frontier — the most-recently-advanced contributor's phase — or undefined when no node in
   *  the tree has a derived phase. This is the parent/epic's domain phase. */
  readonly frontier?: InstancePhase;
  /** Every stitched instance that has a derived phase, in tree (depth-first) order. */
  readonly contributions: readonly InstancePhase[];
}

/** Order two contributors by progress: later `at` wins; ties break on greater `seq`. A contributor
 *  with an `at` beats one without; when neither has an `at`, `seq` decides. */
function moreAdvanced(a: InstancePhase, b: InstancePhase): boolean {
  const aAt = a.at ?? "";
  const bAt = b.at ?? "";
  if (aAt !== bAt) return aAt > bAt;
  return (a.seq ?? -1) > (b.seq ?? -1);
}

/**
 * Tier 2 — roll a domain phase up across a lineage tree (#254). Each stitched instance contributes
 * its structurally-derived {@link InstancePhase}; the parent/epic phase is the *frontier* of that
 * tree — the most-recently-advanced contributor (latest `at`, then greatest `seq`). This lets a
 * fan-out epic surface the furthest domain phase any of its children has reached, not just the
 * parent instance's own token position. Pure and deterministic.
 */
export function rollupLineagePhase(
  tree: LineageTree,
  phaseByInstance: ReadonlyMap<string, InstancePhase>,
): LineagePhaseRollup {
  const contributions: InstancePhase[] = [];
  const seen = new Set<string>();
  const visit = (node: LineageNode): void => {
    if (seen.has(node.instanceKey)) return;
    seen.add(node.instanceKey);
    const contribution = phaseByInstance.get(node.instanceKey);
    if (contribution) contributions.push(contribution);
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  // `tree.nodes` includes unattached nodes not reachable from root; fold them in too so a
  // contributor whose edge has not yet stitched is not dropped from the epic frontier.
  for (const node of tree.nodes) {
    if (seen.has(node.instanceKey)) continue;
    seen.add(node.instanceKey);
    const contribution = phaseByInstance.get(node.instanceKey);
    if (contribution) contributions.push(contribution);
  }

  let frontier: InstancePhase | undefined;
  for (const c of contributions) {
    if (!frontier || moreAdvanced(c, frontier)) frontier = c;
  }

  return {
    rootRequestKey: tree.rootRequestKey,
    contributions,
    ...(frontier != null ? { frontier } : {}),
  };
}
