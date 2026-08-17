// lineage — the framework-level lineage primitive (issue #254).
//
// Any Urban app wants to stitch *user intent → progress*: a single root request (a
// button press, an inbound webhook, an API call) fans out into the process instances,
// PRs, tasks and sub-loops it *causes*, and an operator wants to see that whole thread.
// Today every app hand-rolls that correlation. This module makes it a framework
// primitive so the next app gets intent→progress threading for free.
//
// Two DISTINCT relationships stitch the thread, and they must stay separate:
//
//   - the LINEAGE / CAUSATION edge (this module): asynchronous causation — the cause does
//     NOT block the effect, edges fan out (1→N), descendants settle independently and
//     survive their ancestor's termination, and they are created by message-start / API
//     `createInstance` / webhooks as much as by call activities. Carried as a reserved
//     `_urban.lineage` envelope on every instance/message the SDK starts, AUTO-THREADED
//     from the ambient job context (see {@link applyAmbientLineage}).
//   - the EXECUTION edge (`parentProcessInstanceKey`, engine-native — Magikcraft/nano-bpm#808):
//     synchronous delegation where the parent token blocks on the child. This module does
//     NOT duplicate it; the read projection ({@link buildLineageTree}) CONSUMES it as a
//     strong edge, unioned with the weak/causal edges of the envelope.
//
// This file is intentionally `node:*`-free (the host contract): the only ambient
// capability it reaches for is `crypto.randomUUID` (a Web/global, not `node:crypto`),
// with a portable fallback.

import { currentJobContext, type JobExecContext } from "./execContext.ts";
import { isRecord } from "./guards.ts";

/** The reserved variable namespace the lineage envelope lives under on every
 *  instance/message (`_urban.lineage`). Kept as one object so future framework
 *  conventions can share the `_urban.*` namespace without colliding. */
export const LINEAGE_NAMESPACE = "_urban";
/** The key of the lineage envelope within {@link LINEAGE_NAMESPACE}. */
export const LINEAGE_KEY = "lineage";

/**
 * The lineage envelope, a reserved convention on every instance/message:
 * `_urban.lineage = { rootRequestKey, causedByInstanceKey? }`.
 *  - `rootRequestKey` threads every descendant of a single top-level request back to
 *    it; it is PRESERVED verbatim across the whole causal tree.
 *  - `causedByInstanceKey` is the instance that directly caused this one (the weak
 *    parent edge). Absent on a genuine top-level request (a fresh root).
 */
export interface LineageEnvelope {
  readonly rootRequestKey: string;
  readonly causedByInstanceKey?: string;
}

/** Options for {@link applyAmbientLineage}, injectable for deterministic tests. */
export interface ApplyLineageOptions {
  /** Override the ambient job context (defaults to {@link currentJobContext}). */
  readonly ambient?: JobExecContext | undefined;
  /** Override the fresh-root minter (defaults to {@link mintRootRequestKey}). */
  readonly mintRootRequestKey?: () => string;
}

/** Mint a fresh `rootRequestKey` for a genuine top-level request (no ambient lineage).
 *  Uses `crypto.randomUUID` where available (Node ≥ 16.7 / Deno expose it as a global),
 *  with a time+random fallback so this stays host-agnostic and never throws. */
export function mintRootRequestKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `root-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Coerce a value to a non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read the `_urban.lineage` envelope from a variables map, or `undefined` when absent or
 * malformed (no/blank `rootRequestKey`). Tolerant by design: a bad envelope degrades to
 * "no ambient lineage" rather than throwing on the hot instance-creation path.
 */
export function readLineage(variables: unknown): LineageEnvelope | undefined {
  if (!isRecord(variables)) return undefined;
  const ns = variables[LINEAGE_NAMESPACE];
  if (!isRecord(ns)) return undefined;
  const env = ns[LINEAGE_KEY];
  if (!isRecord(env)) return undefined;
  const rootRequestKey = nonEmptyString(env.rootRequestKey);
  if (!rootRequestKey) return undefined;
  return { rootRequestKey, causedByInstanceKey: nonEmptyString(env.causedByInstanceKey) };
}

/** Normalise an envelope for storage in variables — drop an absent `causedByInstanceKey`
 *  rather than serialising `undefined`, so a fresh root's envelope is `{ rootRequestKey }`. */
function toEnvelopeRecord(envelope: LineageEnvelope): Record<string, unknown> {
  return envelope.causedByInstanceKey
    ? { rootRequestKey: envelope.rootRequestKey, causedByInstanceKey: envelope.causedByInstanceKey }
    : { rootRequestKey: envelope.rootRequestKey };
}

/**
 * Return a COPY of `variables` with `envelope` written under `_urban.lineage`, preserving
 * any other `_urban.*` keys. Never mutates the input.
 */
export function writeLineage(
  variables: Record<string, unknown> | undefined,
  envelope: LineageEnvelope,
): Record<string, unknown> {
  const base = isRecord(variables) ? variables : {};
  const ns = isRecord(base[LINEAGE_NAMESPACE]) ? base[LINEAGE_NAMESPACE] : {};
  return { ...base, [LINEAGE_NAMESPACE]: { ...ns, [LINEAGE_KEY]: toEnvelopeRecord(envelope) } };
}

/**
 * Derive the envelope to attach to a NEW instance/message given the ambient job context.
 *  - Ambient lineage present → PROPAGATE it: preserve `rootRequestKey`, set
 *    `causedByInstanceKey` to the current instance (the cause).
 *  - Ambient job with an instance but no envelope → that instance is itself a root; the
 *    child inherits `rootRequestKey = <ambient instance>` and is caused by it.
 *  - No ambient job at all (a genuine top-level request) → MINT a fresh `rootRequestKey`.
 */
export function deriveLineage(
  ambient: JobExecContext | undefined,
  mint: () => string = mintRootRequestKey,
): LineageEnvelope {
  const rootRequestKey = ambient?.rootRequestKey ?? ambient?.instanceKey;
  if (rootRequestKey) {
    return { rootRequestKey, causedByInstanceKey: ambient?.instanceKey };
  }
  return { rootRequestKey: mint() };
}

/**
 * The single, adapter-agnostic step that auto-threads lineage onto a `createInstance` /
 * `publishMessage` call's variables. Both the live `SdkEngineClient` and the testkit's
 * `WasmEngineClient` route through this (No Drift Surfaces), so lineage threads identically
 * in production and in-harness.
 *
 * An EXPLICIT caller-supplied `_urban.lineage` always wins (start a new root or re-parent
 * deliberately) — it is returned untouched. Otherwise the envelope is derived from the
 * ambient job context ({@link deriveLineage}) and merged in.
 */
export function applyAmbientLineage(
  variables: Record<string, unknown> | undefined,
  opts: ApplyLineageOptions = {},
): Record<string, unknown> {
  const base = isRecord(variables) ? variables : {};
  if (readLineage(base)) return { ...base };
  const ambient = opts.ambient !== undefined ? opts.ambient : currentJobContext();
  return writeLineage(base, deriveLineage(ambient, opts.mintRootRequestKey));
}

// ---------------------------------------------------------------------------
// Read projection — union the weak (envelope) and strong (parentProcessInstanceKey)
// edges into a stitched descendant tree keyed by rootRequestKey.
// ---------------------------------------------------------------------------

/** How a node connects to its cause. `weak` = the causal envelope edge; `strong` = the
 *  engine-native execution edge (`parentProcessInstanceKey`, Magikcraft/nano-bpm#808). */
export type LineageEdgeType = "weak" | "strong";

/** One directed edge cause → effect in a lineage tree. `causedByInstanceKey` is absent on a
 *  root's own edge. */
export interface LineageEdge {
  readonly rootRequestKey: string;
  /** The effect / descendant instance this edge lands on. */
  readonly instanceKey: string;
  /** The cause / parent instance, or `undefined` for a root. */
  readonly causedByInstanceKey?: string;
  readonly edgeType: LineageEdgeType;
}

/** An app-registered domain row attached to a lineage node (a PR, a task, …). The framework
 *  stores it opaquely by `(nodeKey, kind, ref)` without knowing the app's schema. */
export interface LineageAttachment {
  /** The instance key this row hangs off. */
  readonly nodeKey: string;
  /** App-defined category, e.g. `"pull_request"`, `"task"`. */
  readonly kind: string;
  /** App-defined reference into its own store, e.g. a PR key. */
  readonly ref: string;
  /** Optional human-readable label. */
  readonly label?: string;
}

/** A node in the stitched lineage tree. */
export interface LineageNode {
  readonly instanceKey: string;
  /** How this node connects to its parent; `undefined` for the root. */
  readonly edgeType?: LineageEdgeType;
  readonly causedByInstanceKey?: string;
  readonly attachments: LineageAttachment[];
  readonly children: LineageNode[];
}

/** The stitched descendant tree for one `rootRequestKey`. */
export interface LineageTree {
  readonly rootRequestKey: string;
  /** The root node of the stitched tree, always present. Normally the top-level request's own
   *  instance; when `rootRequestKey` is a minted synthetic key, the parentless root instance it
   *  threads. Falls back to a synthetic node keyed by `rootRequestKey` when no edges exist. */
  readonly root: LineageNode;
  /** Every node keyed by instance, in insertion order — a convenience flat view. */
  readonly nodes: LineageNode[];
}

/**
 * Build the stitched descendant tree for `rootRequestKey` by unioning weak and strong edges.
 * When both edge sources connect the SAME node, the STRONG (engine execution) edge wins — it
 * is the authoritative parent — so #808's native edge supersedes the envelope's weak guess
 * without duplicating it. Nodes whose parent chain does not reach the root stay unattached
 * (they still appear in `nodes`). The root is the instance keyed by `rootRequestKey` when that
 * is itself an instance, else the single parentless recorded instance (a minted `rootRequestKey`
 * is a synthetic correlation key, not an instance), else a synthetic node. Pure and
 * deterministic — the store is a thin persistence layer over this.
 */
export function buildLineageTree(
  rootRequestKey: string,
  edges: readonly LineageEdge[],
  attachments: readonly LineageAttachment[] = [],
): LineageTree {
  // Collapse to one edge per effect instance: strong supersedes weak.
  const byInstance = new Map<string, LineageEdge>();
  for (const e of edges) {
    if (e.rootRequestKey !== rootRequestKey) continue;
    const prev = byInstance.get(e.instanceKey);
    if (!prev || (prev.edgeType === "weak" && e.edgeType === "strong")) {
      byInstance.set(e.instanceKey, e);
    }
  }

  const nodes = new Map<string, MutableNode>();
  const ensure = (instanceKey: string): MutableNode => {
    let n = nodes.get(instanceKey);
    if (!n) {
      n = { instanceKey, attachments: [], children: [] };
      nodes.set(instanceKey, n);
    }
    return n;
  };

  // Speculatively materialise the `rootRequestKey` node so descendants whose cause IS the root
  // (a child inherits the root's own instance key as `rootRequestKey`) can attach to it below.
  const rootByKey = ensure(rootRequestKey);

  for (const e of byInstance.values()) {
    const node = ensure(e.instanceKey);
    node.edgeType = e.edgeType;
    node.causedByInstanceKey = e.causedByInstanceKey;
  }

  // Attachments are an app extension point keyed by instance. MATERIALISE the target node even
  // when no edge has been recorded for it yet, so an attachment for an as-yet-unstitched instance
  // is preserved in `tree.nodes` (unattached until its edge lands) rather than silently dropped.
  for (const a of attachments) {
    const node = ensure(a.nodeKey);
    node.attachments.push({ nodeKey: a.nodeKey, kind: a.kind, ref: a.ref, ...(a.label ? { label: a.label } : {}) });
  }

  for (const node of nodes.values()) {
    const parentKey = node.causedByInstanceKey;
    if (parentKey && parentKey !== node.instanceKey && nodes.has(parentKey)) {
      ensure(parentKey).children.push(node);
    }
  }

  // Resolve the root node. Usually `rootRequestKey` IS the root instance's own key, so `rootByKey`
  // carries that instance's edge and descendants. But a genuine top-level request (no ambient job)
  // MINTS a synthetic `rootRequestKey` — a UUID that is not any instance — so `rootByKey` is an
  // empty phantom while the real root is the single recorded instance with no cause. Prefer that
  // parentless instance and drop the phantom, so the tree is never rooted at a childless synthetic
  // node with the real root left floating detached (the bug this guards against).
  let root = rootByKey;
  const rootIsPhantom =
    rootByKey.edgeType === undefined && rootByKey.children.length === 0 && rootByKey.attachments.length === 0;
  if (rootIsPhantom) {
    // A candidate real root is a parentless node that is genuinely part of the causal structure —
    // it has its own recorded edge or descendants. Attachment-only orphan nodes (materialised above
    // with no edge and no children) are NOT candidates, so a stray attachment can never shadow the
    // real parentless root and re-introduce the phantom-root bug guarded by the minted-root case.
    const parentlessInstances = [...nodes.values()].filter(
      (n) =>
        n !== rootByKey &&
        n.causedByInstanceKey === undefined &&
        (n.edgeType !== undefined || n.children.length > 0),
    );
    if (parentlessInstances.length === 1) {
      root = parentlessInstances[0];
      nodes.delete(rootRequestKey);
    }
  }

  return { rootRequestKey, root, nodes: [...nodes.values()] };
}

/** The internal, mutable view of {@link LineageNode} used while building the tree. */
interface MutableNode {
  instanceKey: string;
  edgeType?: LineageEdgeType;
  causedByInstanceKey?: string;
  attachments: LineageAttachment[];
  children: MutableNode[];
}
