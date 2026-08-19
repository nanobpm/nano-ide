# `src/nodes/` — the flow-node kind extension seam

Every flow-node **kind** in the declarative surface (`run`, `task`, `signal`,
`timer`, `switch`, `branch`, `loop`, `break`, `continue`, `parallel`, `forEach`,
and any kind a feature slice adds) lives in its **own module** here. Adding a
kind is: **drop one `src/nodes/<kind>.ts` file.** You never edit a shared union,
a central `switch`, or the barrel.

This exists so the four wave-1 slices (S1–S4, #316–#319) can each add a kind in
parallel without textually colliding on — and without any single PR's CI failing
to exercise — the dispatch that used to be a hand-edited `switch` in two files.

## What a kind module contributes (three things, one file)

A kind module `src/nodes/<kind>.ts` declaration-merges its type surface and
registers its runtime behaviour with a single `registerNodeKind(...)` call:

1. **Its `FlowNode` variant** — by declaration-merging one property into the
   augmentable `FlowNodeRegistry` interface (in `../types.js`). `FlowNode` is
   derived from that registry (`FlowNodeRegistry[keyof FlowNodeRegistry]`), so
   the union grows automatically — no edit to a central union.
   - **Invariant:** the property value MUST be an object type whose `kind`
     discriminant equals the property key, so `FlowNode` stays a discriminated
     union.

2. **Its builder method** — by declaration-merging the method signature into the
   `FlowBuilder<C>` interface (in `../declarative.js`) **and** returning a
   `build` factory from `registerNodeKind`. The factory receives the per-body
   `BuildApi` and returns the method installed on the builder as
   `w.<builderMethod ?? kind>(…)`.

3. **Its `walk` + `emit` handlers** — registered in the same call. `walkNodes`
   and the BPMN emitter DISPATCH through this table instead of a central switch:
   - `walk(node, recurse)` — recurse into the node's nested bodies (omit for a
     leaf kind with no nested `FlowNode[]`).
   - `emit(node, incoming, loop, api)` — place the node's BPMN element(s) via the
     `EmitApi` primitives and return the outgoing (dangling) `Edge[]` its
     continuation attaches to.

## The canonical example — `run.ts`

```ts
import type { NodeEnvelopes, StepHandler } from "../types.js";
import { registerNodeKind } from "./registry.js";

// (1) the FlowNode variant — declaration-merged into the open registry
declare module "../types.js" {
  interface FlowNodeRegistry {
    run: { kind: "run"; name: string; envelopes?: NodeEnvelopes };
  }
}

registerNodeKind("run", {
  // (2) the builder method — installed as `w.run(...)`
  build: (api) => (name: string, handler: StepHandler) => {
    api.claim(name);
    if (typeof handler !== "function") throw new Error(`run("${name}") needs a handler`);
    api.handlers[name] = handler;
    api.out.push({ kind: "run", name, envelopes: api.contractEnvelopes(name) });
    return api.self();
  },
  // (3a) walk — omitted here: `run` is a leaf (no nested bodies)
  // (3b) emit — place the BPMN element, wire the edges
  emit: (node, incoming, _loop, api) => {
    api.addServiceTask(node);
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
```

A kind with its OWN richer, generically-typed builder signature (like the
built-ins) also augments `FlowBuilder<C>`:

```ts
declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    myKind<K extends string>(name: K, opts: MyOpts): FlowBuilder<C>;
  }
}
```

A kind with nested bodies (like `switch`/`branch`/`loop`) supplies `walk` and
uses `api.child(fn, inLoop)` / `api.childScoped(fn)` in its `build`, and
`api.emitList(body, incoming, loop)` in its `emit` — see `switch.ts`, `loop.ts`,
`forEach.ts`.

## The APIs you get

- **`BuildApi`** (authoring time, in `build`): `id`, `isRoot`, `out`,
  `contracts`, `handlers`, `loopDepth`, `self()`, `child(fn, inLoop)`,
  `childScoped(fn)`, `claim(name)`, `contractEnvelopes(name)`, `setStartTimer(t)`.
- **`EmitApi`** (compile time, in `emit`): `flowId`, `newEdge`, `connect`,
  `recordEnvelope`, `emitList`, `addNode`, `addServiceTask`, `addCatchEvent`,
  `addTimerCatchEvent`, `addGateway`, `addParallelGateway`, `addSubProcess`,
  `addPlainStart`, `addPlainEnd`, `nextGw()`, `currentScope()`, `pushScope`,
  `popScope`. Node-render string helpers (`incomingOutgoing`, `escapeXml`, …) are
  exported from `../declarative.js` / `../xml.js` for a custom `RenderNode.render`.

All are exported from `../declarative.js`; the registration function and its
`NodeKindHandlers<N>` type are in `./registry.js`.

## Rules

- **Never** edit `FlowNodeRegistry` in `types.ts`, the `FlowBuilder<C>` interface
  outside your own `declare module`, or `index.ts` (it is generated — see below).
- **Import types with `import type`** (the package uses
  `verbatimModuleSyntax`).
- **No `as T` assertions** (repo-wide ban — see the root `AGENTS.md`); narrow with
  a type guard, an annotation, or `satisfies`.
- Register **exactly once** per kind (`registerNodeKind` throws on a duplicate
  kind; builder assembly in `makeBuilder` additionally throws when two kinds
  contribute the same duplicate builder-method name).

## The generated barrel

`index.ts` is **generated** by `scripts/gen-node-registry.mjs` (a `build`/
`typecheck` prebuild step): it scans this directory and emits a sorted list of
side-effect imports so every kind's `registerNodeKind(...)` runs. Because it is
regenerated and alphabetically ordered, two slices that each add a different
`<kind>.ts` file merge without conflict and are wired automatically — **do not
hand-edit `index.ts`.** (`package.json`'s `sideEffects` allowlist keeps a
downstream bundler from tree-shaking these registrations away.)
