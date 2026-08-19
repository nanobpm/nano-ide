// The builder-extension seam (epic #314, S0/#315).
//
// Every flow-node KIND (`run`/`task`/`signal`/`timer`/`switch`/… and any kind a
// feature slice adds) contributes THREE things from its own module under
// `src/nodes/`, and NOTHING is edited centrally:
//
//   1. a `FlowNode` variant — by declaration-merging its shape into the
//      augmentable `FlowNodeRegistry` interface (see `types.ts`), so the
//      `FlowNode` union grows without editing a central union;
//   2. a builder method — by declaration-merging its signature into the
//      `FlowBuilder<C>` interface (see `declarative.ts`) and registering a
//      `build` factory here, so `w.<method>(…)` is contributed from the module;
//   3. `walk` + `emit` handlers — registered here, so the tree walker and the
//      BPMN emitter DISPATCH through this table instead of a central `switch`.
//
// A module registers all three with a single `registerNodeKind(kind, {…})` call
// at import time; the generated barrel `src/nodes/index.ts` imports every kind
// module for its registration side effect. Adding a kind is therefore: drop one
// `src/nodes/<kind>.ts` file — no edit to the union, the dispatch, or the barrel.
//
// See `src/nodes/README.md` for the exact pattern a slice follows.

import type { FlowNode } from "../types.js";
import type { BuildApi, BuilderMethod, Edge, EmitApi, LoopCtx } from "../declarative.js";

/** Recurse the tree walker into a node's nested bodies (see `walkNodes`). */
export type WalkRecurse = (body: FlowNode[]) => void;

/** The three handlers a flow-node kind contributes. `N` is the kind's own
 *  `FlowNode` variant (narrowed from the union by the registry key). */
export interface NodeKindHandlers<N extends FlowNode = FlowNode> {
  /** Factory for the `FlowBuilder` method that appends this kind's node. Given
   *  the per-body {@link BuildApi}, returns the method installed on the builder
   *  as `w.<builderMethod ?? kind>`. Omit for a kind with no authoring method. */
  build?: (api: BuildApi) => BuilderMethod;
  /** The builder method name, when it differs from the kind (defaults to the
   *  kind). */
  builderMethod?: string;
  /** Depth-first recursion into the node's nested bodies. Omit for a leaf. */
  walk?: (node: N, recurse: WalkRecurse) => void;
  /** Emit this node into the BPMN graph, returning the outgoing (dangling)
   *  edges its continuation attaches to. */
  emit: (node: N, incoming: Edge[], loop: LoopCtx | null, api: EmitApi) => Edge[];
}

// The dispatcher always looks a handler up by `node.kind` before calling it, so
// each stored handler only ever receives a node of its own kind. Storing the
// widened `NodeKindHandlers<FlowNode>` is therefore sound; a kind registers with
// its own narrowed variant type for authoring ergonomics.
const kinds = new Map<string, NodeKindHandlers>();

/** Register the handlers for one flow-node kind. Called once, at module import
 *  time, from `src/nodes/<kind>.ts`. */
export function registerNodeKind<K extends FlowNode["kind"]>(
  kind: K,
  handlers: NodeKindHandlers<Extract<FlowNode, { kind: K }>>,
): void {
  if (kinds.has(kind)) {
    throw new Error(`flow-node kind "${kind}" is already registered`);
  }
  const walk = handlers.walk;
  const emit = handlers.emit;
  kinds.set(kind, {
    builderMethod: handlers.builderMethod,
    build: handlers.build,
    walk: walk ? (node, recurse) => walk(narrow(node, kind), recurse) : undefined,
    emit: (node, incoming, loop, api) => emit(narrow(node, kind), incoming, loop, api),
  });
}

/** Narrow a dispatched node back to a kind's own variant. The discriminant
 *  check is the proof — no `as` cast. The dispatcher guarantees `node.kind ===
 *  kind`, so the throw is unreachable in practice. */
function narrow<K extends FlowNode["kind"]>(node: FlowNode, kind: K): Extract<FlowNode, { kind: K }> {
  if (isKind(node, kind)) return node;
  throw new Error(`internal: node of kind "${node.kind}" dispatched to handler for "${kind}"`);
}

function isKind<K extends FlowNode["kind"]>(node: FlowNode, kind: K): node is Extract<FlowNode, { kind: K }> {
  return node.kind === kind;
}

/** The handlers registered for a kind, or `undefined` if none. */
export function nodeKind(kind: string): NodeKindHandlers | undefined {
  return kinds.get(kind);
}

/** The registered kind, or a thrown error naming the unknown kind — used by the
 *  emitter, which cannot proceed without a handler. */
export function requireNodeKind(kind: string): NodeKindHandlers {
  const h = kinds.get(kind);
  if (!h) {
    throw new Error(
      `no handler registered for flow-node kind "${kind}" — ` +
        `did its module under src/nodes/ import and call registerNodeKind()?`,
    );
  }
  return h;
}

/** Every registered kind + its handlers, in registration order. Used by
 *  `makeBuilder` to install each kind's builder method. */
export function eachNodeKind(): Iterable<[string, NodeKindHandlers]> {
  return kinds.entries();
}
