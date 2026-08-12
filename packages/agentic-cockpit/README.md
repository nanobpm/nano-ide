# @nanobpm/agentic-cockpit

The **visibility page (the cockpit)** for the Nano agentic protocol — ADR 0056,
slice **S8** of epic [nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124).

The operator's cockpit over the one app-tier channel:

- a **demand×supply matrix**, one row per network, from the S4
  `@nanobpm/agentic-demand` report;
- a red **"missing agent type"** light for every demanded routing token no
  registered worker can fill (`demand ∖ supply`);
- the **diversity-SLO** state (green / amber / red) from S3, carried through S4;
- **drill-into-a-worker → a live terminal** over the S5 `@nanobpm/agentic-relay`
  stream that **survives a cockpit reconnect** via resume-from-offset.

It renders **identically embedded** (console App View, ADR 0057) **and
standalone/phone** — both shells call the same `bootCockpit` against the same
`renderCockpit`, differing only in the host element and injected endpoints.

## Design

The package is a **framework-free, injection-based core** — no hard dependency
on the DOM, a socket implementation, or xterm.js. Everything is passed in, which
is what makes the whole page (live refresh, drill-in, resume-on-reconnect)
unit-testable on Node and what guarantees the embedded and standalone paths are
one code path.

| Module | Responsibility |
| --- | --- |
| `view.ts` | Pure projection: S4 `DemandSupplyReport` → `CockpitView` (matrix rows, missing lights, diversity light). Deterministic, side-effect-free. |
| `terminal-session.ts` | The relay consumer with **resume-from-offset**. Tracks `nextOffset`; re-attaches from it on every reconnect; drops already-applied replays (no loss, no dup). |
| `relay-client.ts` | Encodes/decodes S0 frames over an injected socket; **re-opens on drop and re-fires `onOpen` on every (re)connect** so the session resumes. Timer- and transport-injected. |
| `render.ts` | Renders a `CockpitView` against a **structural** DOM subset (`ElementLike`/`DocumentLike`), so the browser passes real DOM and tests pass a fake — one render path, no DOM library, no `as`. |
| `boot.ts` | Orchestration: a **self-scheduling** poll of the report + matrix render, plus drill-in wiring the terminal into a **persistent** region (a matrix refresh never wipes it). |

### Invariants honoured

- **App-tier, engine frozen.** The report is an ordinary read; the terminal
  rides the app-tier relay channel. Nothing here touches the Camunda-8 engine or
  its transport.
- **No redefinition.** The wire contract comes from `@nanobpm/agentic-protocol`,
  the report from `@nanobpm/agentic-demand`, the diversity SLO from
  `@nanobpm/agentic-vocab`, and the relay sub-protocol from
  `@nanobpm/agentic-relay`.

## Browser wiring

`page/` holds the deployable shells — all plain browser assets, outside the
typechecked/linted `src`:

- `page/mount.js` — the single browser adapter both shells call: real `document`,
  a `fetch`-based report source, a `WebSocket` relay factory, and an xterm.js sink.
- `page/standalone.html` — a self-contained shell (import-map + CDN) that boots
  the cockpit into the page body; runs on a phone with no bundler.
- `page/embed.html` — the console App-View embed; mounts the same cockpit into the
  console-provided host, honouring `window.__NANO_APP_VIEW__` config.
- `page/cockpit.page.json` — the Urban page descriptor hosting the App View.
- `page/cockpit.css` — the shared stylesheet (SLO lights key off `data-status`).

The shells expect the hosting Urban app to serve two endpoints:

- `GET /app/api/agentic/demand` → the S4 `DemandSupplyReport` as JSON, and
- the agentic channel WebSocket (default `/agentic`) with the auth token +
  capability credential in the query.

## Usage (embedding the core directly)

```ts
import { bootCockpit } from "@nanobpm/agentic-cockpit";

const cockpit = bootCockpit({
  host,                       // ElementLike — document.body or the App-View host
  doc: document,              // DocumentLike
  fetchReport: () => fetch("/app/api/agentic/demand").then((r) => r.json()),
  connectRelay: () => openRelaySocket("/agentic?token=…&capability=…"),
  createTerminal: (el) => mountXterm(el),
});
cockpit.start();              // self-scheduling poll; cockpit.dispose() to stop
```
