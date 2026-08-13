# nano-ide

Monorepo for the Nano RAD console IDE. It publishes two families of packages (most
scoped `@nanobpm/*`; the `create-urban-app` scaffolder is unscoped):

- **Extension packs** — plain npm packages discovered + installed from npm in the console
  UI (ADR 0007/0008/0009). The host parses each pack's `nano-ide.ext.json` manifest
  (mirror of the `nano-bpm` repo's `server/src/console/extensions.rs`).
- **The Urban code-first stack** — `@nanobpm/urban` (runtime + derivation toolkit + `urban`
  CLI), `@nanobpm/workflow` (the `defineFlow` durable-orchestration library), and the
  `create-urban-app` scaffolder. These are published libraries/CLIs, **not** packs — they
  have no `nano-ide.ext.json` (ADR 0052/0053/0054/0055).

`deno` ships built into the server (offline baseline).

## Packs
| Package | Kind | What |
| --- | --- | --- |
| `@nanobpm/nano-ide-lang-rust` | lang | Rust file types + cargo toolchain + throughput template |
| `@nanobpm/nano-ide-lang-node` | lang | TypeScript/Node file types + node toolchain + official JS SDK starter |
| `@nanobpm/nano-ide-lang-python` | lang | Python file types + uv toolchain + Camunda SDK starter template |
| `@nanobpm/nano-ide-lang-csharp` | lang | C# file types + dotnet toolchain + Camunda SDK starter template |
| `@nanobpm/nano-ide-lang-java` | lang | Java file types + Maven toolchain + Camunda client + job worker starter |
| `@nanobpm/nano-ide-app-deno-gui` | app | Deno served-UI binary template |
| `@nanobpm/nano-ide-app-workflow` | app | Code-first durable workflow starters built on `@nanobpm/workflow` (`defineFlow`): a declarative flow with human-in-the-loop signals; the BPMN model, job types, and correlation wiring are derived from code |
| `@nanobpm/nano-ide-app-embedded-nano` | app | Embedded engine — self-contained binary, no gateway (ADR 0005) |
| `@nanobpm/nano-ide-app-embedded-jvm` | app | Embedded Nano (JVM): inner Bernd engine serving an outer BPMN task (ADR 0005) |
| `@nanobpm/nano-ide-app-embedded-graalvm-native` | app | Embedded Nano as a ~30 MB GraalVM native-image binary (ADR 0005) |
| `@nanobpm/nano-ide-example-rust-throughput` | example | Native Rust pipelined command-stream throughput demo |
| `@nanobpm/nano-ide-example-node-throughput` | example | Node throughput demo (C8 REST ↔ Nano Falcon) |
| `@nanobpm/nano-ide-example-python-throughput` | example | Python throughput demo on the Camunda 8 REST SDK |
| `@nanobpm/nano-ide-example-csharp-throughput` | example | C# throughput demo on the Camunda 8 REST SDK |
| `@nanobpm/nano-ide-example-java-throughput` | example | Java throughput demo (C8 REST/gRPC ↔ Nano Falcon) |
| `@nanobpm/nano-ide-theme-nord` | theme | Nord Dark + Nord Light console themes |
| `@nanobpm/nano-ide-theme-solarized` | theme | Solarized Dark + Light console themes |
| `@nanobpm/nano-ide-theme-synthwave` | theme | Synthwave '84 neon console theme |
| `@nanobpm/nano-ide-trigger-mqtt` | trigger | MQTT event trigger — start processes from broker messages |
| `@nanobpm/nano-ide-connector-slack` | trigger | Slack connector pack — outbound "Send Slack Message" worker + inbound Slack events/slash-command trigger source (ADR 0033/0050) |

## Libraries
Published libraries + tooling — no `nano-ide.ext.json`, not installed as packs.
| Package | What |
| --- | --- |
| `@nanobpm/nano-ide-ext-types` | TypeScript types for the `nano-ide.ext.json` pack manifest |
| `@nanobpm/urban` | Urban runtime + derivation toolkit + `urban` CLI — build and run code-first apps from a `nano.app.json` manifest on Node or Deno (ADR 0053/0054/0055) |
| `@nanobpm/workflow` | Code-first durable orchestration — author a flow with `defineFlow` and derive the BPMN model, job types, and correlation wiring; `defineFlow` is the blessed surface (imperative `defineWorkflow` is experimental/internal) (ADR 0044/0045) |
| `create-urban-app` | `npm create urban-app` scaffolder for a runnable Urban app that runs on Node and Deno (ADR 0052) |

## Capabilities

- **[The Nano agentic protocol](docs/nano-agentic-protocol.md)** — a generic
  `@nanobpm/urban` capability: one app-tier channel carrying agent
  presence/registry, demand×supply, the blackboard, and live terminal relay (ADR
  0056/0057; epic [#124](https://github.com/nanobpm/nano-ide/issues/124)). See the
  [example wiring](docs/examples/boot-agentic-channel.md) that boots the channel.

## Pack kinds
- **lang** — file types (Monaco lazy-loads the grammar), toolchain (detect/run/compile/targets), templates.
- **app** — project template producing a runnable/compilable binary (e.g. Deno GUI, or an embedded-engine app).
- **example** — a complete app shipped under `appDir`, copied into a new project; `requires[]` lists needed lang packs.
- **theme** — console colour themes as pure data: `themes[]` maps the console's design tokens (`app`, `panel`, `accent`, …) to CSS colours over a light or dark base. No code, no toolchain, no trust prompt.
- **trigger** — an event source (e.g. an MQTT broker) that starts processes from external messages.

Any kind may additionally contribute **`tours[]`** — guided journeys offered in the
console's journey picker (ADR 0049 §7), so a pack that adds a capability can teach
it. See [Contributing a guided journey](#contributing-a-guided-journey).

## Dev
```
npm ci
npm run validate     # check every nano-ide.ext.json
npm run typecheck
npm run build
```
Publish via `node scripts/publish.mjs` (CI on main). Version each pack independently; the
script publishes only versions not yet on npm.

## Authoring a pack

An extension pack is a plain **npm package** with two contract files:

1. **`nano-ide.ext.json`** at the package root — the manifest the console reads
   (see [`packages/ext-types`](packages/ext-types) for the typed schema, or the
   [Nano BPM website](https://nanobpm.io) for published docs).
2. **`package.json`** with:
   - `keywords` including `"nano-ide-ext"` (marketplace discovery).
   - `files` shipping at least `nano-ide.ext.json` plus your `templates/` or `app/` dir.
   - `publishConfig.access: "public"`.

The console discovers packs by the `nano-ide-ext` npm keyword, installs the
tarball into the workspace, reads the manifest, and wires the pack in — no
`preinstall`/`postinstall` scripts run.

### `nano-ide.ext.json` at a glance

```jsonc
{
  "id": "my-pack",                  // stable pack id, must be unique
  "kind": "lang" | "app" | "example" | "theme" | "trigger",
  "displayName": "Human name",

  // lang packs
  "fileTypes": [{ "ext": ".rs", "monacoLang": "rust" }],
  "toolchain": {
    "detect":  ["cargo", "--version"],
    "run":     ["cargo", "run", "--release"],
    "compile": ["cargo", "build", "--release"],
    "targets": [],                  // cross-compile triples, optional
    "installUrl":  "https://…",     // shown when detect fails
    "installHint": "brew install rust"
  },

  // lang / app packs — templates surfaced in the New Project picker
  "templates": [
    { "id": "my-starter", "label": "Human label shown in the picker" }
  ],

  // example packs
  "appDir":   "app",                // dir copied into the new project
  "requires": ["rust"],             // lang pack ids the example needs
  "summary":  "One-line description"
}
```

### Kinds

Pick the one you're publishing.

#### `lang` — a language

Wires a file extension into Monaco, plus a **toolchain** the supervisor drives
(`detect` probe, `run`, `compile`, cross-compile `targets`, `installUrl`/`installHint`
for when the toolchain is missing). May also contribute starter templates under
`templates/<id>/`.

Layout:

```
packages/lang-mylang/
├── package.json            # name: @you/nano-ide-lang-mylang
├── nano-ide.ext.json       # kind: "lang"
└── templates/
    └── my-starter/         # copied into new projects picking this template id
        ├── ...
```

Example: [`packages/lang-rust`](packages/lang-rust) — Rust file type +
`cargo` toolchain + a Rust starter.

#### `app` — an output/runtime template

Ships one or more project templates that scaffold a runnable/compilable
application (e.g. a Deno GUI app, a Java Maven module). Same `templates[]`
+ `templates/<id>/` shape as lang packs; no `fileTypes`/`toolchain` required
if the lang side is already covered by an existing pack.

Example: [`packages/app-deno-gui`](packages/app-deno-gui).

#### `example` — a ready-to-run reference app

**The whole pack is the template.** No `templates[]` needed. Ship your project
under `appDir` (conventionally `app/`), list `requires[]` of lang packs the
example needs to build, and write a `summary`. The console auto-registers
example packs in the New Project picker (label = `"<displayName> — <summary>"`),
so you never have to patch someone else's lang pack to make your example
discoverable.

Layout:

```
packages/example-my-demo/
├── package.json            # name: @you/nano-ide-example-my-demo
├── nano-ide.ext.json       # kind: "example", appDir: "app"
└── app/                    # copied verbatim into the new project
    ├── README.md
    └── ...
```

Example: [`packages/example-rust-throughput`](packages/example-rust-throughput).

### Contributing a guided journey

Any pack may add **`tours[]`**: short, outcome-shaped onboarding paths the console
offers in its journey picker (ADR 0049 §7). This is how onboarding scales with the
marketplace instead of living in a hardcoded list in the console — a pack that adds
a capability can teach it. A pack journey is only offered when its pack is
installed, which falls out of it being a pack journey.

```jsonc
"tours": [{
  "id": "mqtt-message-starts-a-process",
  "title": "Start a process from a broker message",
  "blurb": "Wire an MQTT topic to a process start.",   // the picker card line
  "profiles": ["studio"],                              // omit ⇒ studio only
  "preconditions": ["hasProject"],                     // not offered unless met
  "steps": [
    { "id": "intro", "kind": "note", "title": "…", "body": "…" },
    { "id": "run", "title": "…", "body": "…",          // kind defaults to spotlight
      "selector": "[data-tour=\"run\"]", "side": "bottom",
      "precondition": "hasJsRuntime",
      "repair": { "id": "need-runtime", "kind": "note", "title": "…", "body": "…" } },
    { "id": "publish", "kind": "handoff", "title": "…", "body": "…",
      "copy": "mosquitto_pub -h localhost -t home/porch/motion -m '{\"value\":1}'" }
  ]
}]
```

The rules, all enforced by `npm run validate`:

- **Five steps or fewer.** A journey needing a detour is split, not padded.
- **A pack ships data, never code.** `precondition` / `successWhen` name a gate
  from a closed set — `hasJsRuntime`, `hasProject`, `hasCluster`, `hasTraces` —
  which the console resolves against its own precondition library. There is
  deliberately no expression language: it would be a second, weaker copy of that
  library.
- **`repair` is required when the gate can demand one** (`hasJsRuntime`,
  `hasCluster`). Without it the step is silently dropped, which is the honest
  degradation but costs the user the hint they needed — e.g. "install a runtime"
  instead of a step telling them to press Run on a host where Run cannot work.
- **`handoff` steps require a trusted pack.** A handoff's `copy` is a command the
  user is invited to paste into a shell, so the host strips handoff steps from
  untrusted packs before they reach the browser, and drops a journey left with no
  steps. Nothing is ever executed by the console — it renders `copy` as inert text
  — but that is not a reason for an untrusted pack to put arbitrary text where a
  user expects a trustworthy command. Spotlight and note steps need no trust.
- **`selector` targets a `data-tour` anchor** the console renders. An anchor that
  does not exist yet simply skips the step, so a tour can be written ahead of a
  console anchor landing.
- **Omit `successWhen`** for an orientation-only journey: the console then records
  completion without claiming an outcome.

Example: [`packages/trigger-mqtt`](packages/trigger-mqtt).

### Publishing

- Any npm namespace works; the console filters marketplace results by the
  `nano-ide-ext` keyword, not by scope.
- Bump `version` per pack. `node scripts/publish.mjs` skips versions already
  on npm.
- Users install through **Console → Extensions → search npm**, or by pack name
  from the CLI. The trust store (ADR 0007) prompts before running any
  toolchain command a pack contributes.
