/**
 * The cockpit's structured-stream renderer — S8's drill-in for an ACP stream.
 *
 * When a drilled worker's relay stream is a **structured** ACP stream (its chunks
 * are {@link TRANSCRIPT_EVENT_MARKER}-tagged transcript-event envelopes rather than
 * raw PTY bytes), the {@link TerminalSession} routes each decoded event here instead
 * of the byte-terminal. This renderer does **not** re-parse or pretty-print JSON: it
 * feeds the accumulated typed events straight through the ONE canonical
 * {@link deriveView} fold from `@nanobpm/agentic/transcript` and renders the resulting
 * {@link DerivedView} (turns → messages + tool cards) into the DOM.
 *
 * Like {@link renderCockpit} it builds against the structural {@link ElementLike} /
 * {@link DocumentLike} subset (not lib.dom), so it renders identically embedded and
 * standalone, is unit-tested on Node with the in-memory fake and no `as` cast, and is
 * browser-safe — it relies only on the browser-safe transcript vocab (no `Buffer`).
 *
 * Events arrive offset-keyed and immutable in offset order, so re-deriving the whole
 * (idempotent) log on each event is correct across a resume-from-offset reconnect: a
 * replayed chunk below the resume point never reaches this sink, so no event is
 * dropped or double-applied.
 */
import { type DerivedView, type TranscriptEvent, deriveView } from "../transcript/index.ts";
import type { DocumentLike, ElementLike } from "./render.ts";
import type { StructuredSink } from "./terminal-session.ts";

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolCard(doc: DocumentLike, tool: DerivedView["tools"][number]): ElementLike {
  const card = el(doc, "div", "cockpit-structured-tool");
  card.setAttribute("data-tool", tool.name);
  card.setAttribute("data-offset", String(tool.offset));
  card.setAttribute("data-state", tool.result === undefined ? "pending" : tool.result.ok ? "ok" : "error");
  const head = el(doc, "div", "cockpit-structured-tool-head");
  head.appendChild(el(doc, "span", "cockpit-structured-tool-name", tool.name));
  if (tool.callId !== undefined) head.appendChild(el(doc, "span", "cockpit-structured-tool-id", tool.callId));
  card.appendChild(head);
  if (tool.args !== undefined) {
    card.appendChild(el(doc, "pre", "cockpit-structured-tool-args", JSON.stringify(tool.args)));
  }
  if (tool.result !== undefined) {
    const result = el(doc, "div", "cockpit-structured-tool-result");
    result.setAttribute("data-ok", tool.result.ok ? "true" : "false");
    if (tool.result.content !== undefined) result.textContent = tool.result.content;
    card.appendChild(result);
  }
  return card;
}

function turnSection(doc: DocumentLike, turn: DerivedView["turns"][number]): ElementLike {
  const section = el(doc, "section", "cockpit-structured-turn");
  section.setAttribute("data-turn", String(turn.index));
  section.setAttribute("data-steps", String(turn.steps));
  for (const message of turn.messages) {
    const row = el(doc, "div", "cockpit-structured-message");
    row.setAttribute("data-role", message.role);
    row.setAttribute("data-offset", String(message.offset));
    row.appendChild(el(doc, "span", "cockpit-structured-role", message.role));
    row.appendChild(el(doc, "span", "cockpit-structured-text", message.text));
    section.appendChild(row);
  }
  for (const tool of turn.tools) {
    section.appendChild(toolCard(doc, tool));
  }
  return section;
}

/**
 * Render a derived structured view into `host`, replacing whatever was there.
 * Idempotent: re-call it with the latest {@link DerivedView} on every new event.
 */
export function renderStructured(host: ElementLike, doc: DocumentLike, view: DerivedView): void {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-structured");
  root.setAttribute("data-lifecycle", view.lifecycle);
  root.setAttribute("data-events", String(view.eventCount));
  for (const turn of view.turns) {
    root.appendChild(turnSection(doc, turn));
  }
  host.appendChild(root);
}

/** A structured sink with a `dispose` teardown (mirrors {@link TerminalSink}). */
export interface StructuredTerminal extends StructuredSink {
  dispose(): void;
}

/**
 * Build a {@link StructuredSink} that accumulates the offset-ordered transcript
 * events a structured stream delivers, folds them through the canonical
 * {@link deriveView}, and renders the derived view into `host` on each event. The
 * accumulated log is this sink's own state, so constructing one per drill-in gives
 * each worker its own structured view.
 */
export function createStructuredSink(host: ElementLike, doc: DocumentLike): StructuredTerminal {
  const events: TranscriptEvent[] = [];
  // Render an empty derived view up-front so the structured region is present and
  // consistent before the first event lands.
  renderStructured(host, doc, deriveView(events));
  return {
    event(event: TranscriptEvent): void {
      events.push(event);
      renderStructured(host, doc, deriveView(events));
    },
    dispose(): void {
      events.length = 0;
      host.replaceChildren();
    },
  };
}
