// The page-node type registry the browser renderer draws — the schema's canonical
// set, extended locally with the node types this runtime ships ahead of the schema.
//
// The App page-node contract is owned by @nanobpm/nano-app-schema (ADR 0027): its
// `PAGE_NODE_TYPES` is the canonical registry the Console's Page Composer binds to.
// This runtime's browser renderer must draw exactly that set — a schema type with
// no renderer (or a renderer with no schema type) renders an accepted node as a
// blank <div>, the silent failure #416 fixed for `appView`.
//
// `appView` (ADR 0057 — an embedded App View iframe) ships in this runtime *before*
// it lands in the published schema. Rather than silently diverge, we bridge it here
// — the same "mirror locally until the canonical schema folds it in, then delete the
// bridge and re-export" pattern used for `network` / `terminalStatuses` in
// `manifest.ts` (No Drift Surfaces). This module is the single source of truth for
// the extended set: the browser renderer's `RENDERERS satisfies Record<PageNodeType,
// Renderer>` lock and the runtime drift test both consume `PAGE_NODE_TYPES` from
// here, so the renderer registry and the type union cannot drift.

import { PAGE_NODE_TYPES as SCHEMA_PAGE_NODE_TYPES } from "@nanobpm/nano-app-schema";

/**
 * Page-node types this runtime renders that are NOT (yet) in the canonical schema.
 *
 * When a token here lands in `@nanobpm/nano-app-schema`'s `PAGE_NODE_TYPES` and this
 * package's dep is bumped, drop it from this list (and, once the list is empty, delete
 * this module and re-export `PAGE_NODE_TYPES`/`PageNodeType` straight from the schema).
 */
export const LOCAL_PAGE_NODE_TYPES = [
  // #416 / ADR 0057: an embedded App View — an <iframe> hosting a self-contained view
  // document (e.g. the agent cockpit's embed.html) served alongside the page.
  "appView",
] as const;

/** The full set of page-node types the browser renderer draws: schema ∪ local bridge. */
export const PAGE_NODE_TYPES = [...SCHEMA_PAGE_NODE_TYPES, ...LOCAL_PAGE_NODE_TYPES] as const;

/** A node type the composed-page renderer can draw — one of {@link PAGE_NODE_TYPES}. */
export type PageNodeType = (typeof PAGE_NODE_TYPES)[number];
