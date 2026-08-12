// Browser adapter for @nanobpm/agentic-cockpit (S8).
//
// This is the ONE wiring both the standalone shell and the console App-View embed
// call — they differ only in the host element they pass, so the cockpit renders
// identically embedded and standalone. It supplies the browser capabilities the
// injection-based core (`bootCockpit`) needs: the real `document`, a `fetch`-based
// S4 demand report source, a `WebSocket` relay socket factory, and an xterm.js
// terminal sink. It is plain browser ESM — not part of the typechecked/linted src.
//
// Resolve `@nanobpm/agentic-cockpit` and `@xterm/xterm` via the host page's import
// map (see standalone.html / embed.html).
import { bootCockpit } from "@nanobpm/agentic-cockpit";
import { Terminal } from "@xterm/xterm";

/** An xterm.js-backed terminal sink mounted into `host`. */
function xtermSink(host) {
  const term = new Terminal({ convertEol: true, fontFamily: "ui-monospace, monospace", fontSize: 13 });
  term.open(host);
  return { write: (chunk) => term.write(chunk) };
}

/** A WebSocket relay socket factory for the agentic channel at `url`. */
function relaySocketFactory(url) {
  return () => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    return {
      send: (bytes) => ws.send(bytes),
      close: () => ws.close(),
      onMessage: (cb) => ws.addEventListener("message", (event) => cb(new Uint8Array(event.data))),
      onOpen: (cb) => ws.addEventListener("open", () => cb()),
      onClose: (cb) => ws.addEventListener("close", () => cb()),
    };
  };
}

/**
 * Mount the cockpit into `host` and start polling.
 *
 * @param {Element} host — where the cockpit renders (standalone: document.body; embedded: the App-View host).
 * @param {object} [opts]
 * @param {string} [opts.reportUrl] — the S4 demand×supply JSON endpoint the app serves.
 * @param {string} [opts.relayUrl]  — the agentic channel WebSocket URL (with auth token + capability query).
 * @param {number} [opts.refreshMs] — poll interval (default 2000).
 * @returns the CockpitHandle (call `.dispose()` to tear down).
 */
export function mountCockpit(host, opts = {}) {
  const reportUrl = opts.reportUrl ?? "/app/api/agentic/demand";
  const relayUrl = opts.relayUrl ?? defaultRelayUrl();
  const cockpit = bootCockpit({
    host,
    doc: document,
    fetchReport: async () => {
      const res = await fetch(reportUrl, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`demand fetch failed: ${res.status}`);
      return res.json();
    },
    connectRelay: relaySocketFactory(relayUrl),
    createTerminal: xtermSink,
    refreshMs: opts.refreshMs ?? 2000,
    onError: (err) => console.error("[cockpit]", err),
  });
  cockpit.start();
  return cockpit;
}

/** Derive the channel WebSocket URL from the current origin (path `/agentic`). */
function defaultRelayUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/agentic`;
}
