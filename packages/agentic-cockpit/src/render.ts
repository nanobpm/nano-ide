/**
 * The cockpit DOM renderer — S8.
 *
 * Renders a {@link CockpitView} into a host element: the demand×supply networks
 * matrix, a red light per *missing agent type*, and the diversity-SLO light.
 * Clicking a worker instance calls {@link RenderOptions.onDrill} with that
 * instance's relay stream id. This renders only the *volatile* part of the page
 * (the part that refreshes each poll); the drill-in terminal is owned by
 * {@link mountCockpit} in a persistent region so it survives a matrix refresh.
 *
 * It renders against a **structural** DOM subset ({@link ElementLike} /
 * {@link DocumentLike}) rather than the global `document`, for two reasons that
 * matter to this slice:
 *  1. it is the *same* function the standalone shell and the embedded (App View)
 *     host both call — passing the browser's real `document` and their own host
 *     element — so the two render **identically** by construction (one code path,
 *     no standalone/embedded branch); and
 *  2. a plain in-memory fake satisfies the structural type, so the renderer is
 *     unit-tested on Node with no DOM library and no `as` cast.
 */
import type { CockpitLight, CockpitView, SloStatus } from "./view.ts";

/** The minimal element surface the renderer builds against (a DOM `Element` satisfies it). */
export interface ElementLike {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: ElementLike): ElementLike;
  replaceChildren(): void;
  addEventListener(type: string, handler: () => void): void;
}

/** The minimal document surface the renderer builds against (a DOM `Document` satisfies it). */
export interface DocumentLike {
  createElement(tagName: string): ElementLike;
}

export interface RenderOptions {
  /** Called with a worker instance's relay stream id when the operator drills in. */
  readonly onDrill?: (stream: string) => void;
}

/** Handles into the rendered tree the caller may need. */
export interface CockpitDom {
  /** The freshly built root the view was rendered into. */
  readonly root: ElementLike;
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lightNode(doc: DocumentLike, light: CockpitLight): ElementLike {
  const row = el(doc, "div", "cockpit-light");
  row.setAttribute("data-status", light.status);
  row.setAttribute("data-light-id", light.id);
  const dot = el(doc, "span", "cockpit-dot");
  dot.setAttribute("data-status", light.status);
  row.appendChild(dot);
  row.appendChild(el(doc, "span", "cockpit-light-label", light.label));
  if (light.detail !== undefined) {
    const detail = el(doc, "span", "cockpit-light-detail", light.detail);
    detail.setAttribute("title", light.detail);
    row.appendChild(detail);
  }
  return row;
}

function statusBadge(doc: DocumentLike, id: string, label: string, status: SloStatus): ElementLike {
  const badge = el(doc, "div", "cockpit-status", `${label}: ${status}`);
  badge.setAttribute("data-status", status);
  badge.setAttribute("data-badge-id", id);
  return badge;
}

function tokenCell(doc: DocumentLike, network: CockpitView["networks"][number], options: RenderOptions): ElementLike {
  const table = el(doc, "table", "cockpit-tokens");
  const head = el(doc, "tr", "cockpit-tokens-head");
  head.appendChild(el(doc, "th", "cockpit-th", "token"));
  head.appendChild(el(doc, "th", "cockpit-th", "supply"));
  head.appendChild(el(doc, "th", "cockpit-th", "workers"));
  table.appendChild(head);
  for (const token of network.tokens) {
    const row = el(doc, "tr", "cockpit-token");
    row.setAttribute("data-status", token.status);
    row.setAttribute("data-token", token.token);
    const dot = el(doc, "td", "cockpit-td");
    const light = el(doc, "span", "cockpit-dot");
    light.setAttribute("data-status", token.status);
    dot.appendChild(light);
    dot.appendChild(el(doc, "span", "cockpit-token-name", token.token));
    row.appendChild(dot);
    row.appendChild(el(doc, "td", "cockpit-td", String(token.supply)));
    const workers = el(doc, "td", "cockpit-td cockpit-workers");
    for (const instance of token.instances) {
      const chip = el(doc, "button", "cockpit-worker", instance);
      chip.setAttribute("data-stream", instance);
      chip.setAttribute("type", "button");
      const onDrill = options.onDrill;
      if (onDrill !== undefined) {
        chip.addEventListener("click", () => onDrill(instance));
      }
      workers.appendChild(chip);
    }
    row.appendChild(workers);
    table.appendChild(row);
  }
  return table;
}

function networkSection(doc: DocumentLike, network: CockpitView["networks"][number], options: RenderOptions): ElementLike {
  const section = el(doc, "section", "cockpit-network");
  section.setAttribute("data-status", network.status);
  section.setAttribute("data-network", network.network);
  const header = el(doc, "div", "cockpit-network-head");
  const dot = el(doc, "span", "cockpit-dot");
  dot.setAttribute("data-status", network.status);
  header.appendChild(dot);
  header.appendChild(el(doc, "span", "cockpit-network-name", network.network));
  if (network.missing.length > 0) {
    header.appendChild(el(doc, "span", "cockpit-network-missing", `missing: ${network.missing.join(", ")}`));
  }
  section.appendChild(header);
  section.appendChild(tokenCell(doc, network, options));
  return section;
}

function missingPanel(doc: DocumentLike, view: CockpitView): ElementLike {
  const panel = el(doc, "aside", "cockpit-missing");
  panel.setAttribute("data-empty", view.missingLights.length === 0 ? "true" : "false");
  panel.appendChild(el(doc, "h2", "cockpit-panel-title", "Missing agent types"));
  if (view.missingLights.length === 0) {
    panel.appendChild(el(doc, "div", "cockpit-missing-none", "none — every demanded token is served"));
    return panel;
  }
  for (const light of view.missingLights) {
    panel.appendChild(lightNode(doc, light));
  }
  return panel;
}

/**
 * Render `view` into `host`, replacing whatever was there. Idempotent: call it
 * again on every refresh to reflect the latest demand×supply snapshot.
 */
export function renderCockpit(
  host: ElementLike,
  doc: DocumentLike,
  view: CockpitView,
  options: RenderOptions = {},
): CockpitDom {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit");
  root.setAttribute("data-status", view.status);

  const header = el(doc, "header", "cockpit-header");
  header.appendChild(el(doc, "h1", "cockpit-title", "Agent networks — the cockpit"));
  header.appendChild(statusBadge(doc, "overall", "overall", view.status));
  header.appendChild(lightNode(doc, view.diversityLight));
  root.appendChild(header);

  root.appendChild(missingPanel(doc, view));

  const matrix = el(doc, "div", "cockpit-matrix");
  for (const network of view.networks) {
    matrix.appendChild(networkSection(doc, network, options));
  }
  root.appendChild(matrix);

  if (view.nonAgentic.length > 0) {
    const footer = el(doc, "footer", "cockpit-nonagentic", `non-agentic task types: ${view.nonAgentic.join(", ")}`);
    root.appendChild(footer);
  }

  host.appendChild(root);
  return { root };
}
