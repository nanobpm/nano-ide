// nano-ide.ext.json manifest contract (ADR 0007). Mirrors the host parser in
// nanobpmn server/src/console/extensions.rs — keep in sync.

export type ExtKind = "lang" | "app" | "example" | "theme" | "trigger";

export interface FileType {
  /** File extension including the dot, e.g. ".rs". */
  ext: string;
  /** Monaco language id; the editor lazy-loads it only for matching files. */
  monacoLang: string;
}

export interface Toolchain {
  /** Probe argv proving the toolchain is installed (e.g. ["cargo","--version"]). */
  detect?: string[];
  /** argv to run the project (cwd = project dir). Empty => built-in Deno runner.
   * Serves as a fallback when the active run config's `run` argv is empty. */
  run?: string[];
  /** argv to compile the project. Empty => Deno compile. Serves as a fallback
   * when the active run config's `compile` argv is empty. */
  compile?: string[];
  /** Cross-compile target triples this toolchain offers. */
  targets?: string[];
  /** Named run configurations the console surfaces in a Run/Target dropdown.
   * When set, the supervisor prefers the active one (pinned →
   * `default: true` → first) over the flat `run`/`compile`. */
  runConfigs?: RunConfig[];
  /** Official install instructions for this toolchain, surfaced in the IDE
   * config panel when the `detect` probe fails (e.g. the Rust toolchain page). */
  installUrl?: string;
  /** One-line, actionable hint shown when the toolchain is missing (e.g.
   * "`cargo` was not found. Install the Rust toolchain…"). */
  installHint?: string;
}

/**
 * One named run/compile combo a pack exposes — e.g. an example that swaps
 * transports or build profiles. The console persists the picked id in the
 * project's `nanobpm.project.json` as `toolchain.activeRunConfig`.
 */
export interface RunConfig {
  /** Stable id, unique within the pack (e.g. "stock-grpc"). */
  id: string;
  /** Human-facing label shown in the Run dropdown. */
  label: string;
  /** When no id is pinned by the user, this entry is picked; else the first. */
  default?: boolean;
  /** argv override for this config. Empty => fall back to `Toolchain.run`. */
  run?: string[];
  /** argv override for this config. Empty => fall back to `Toolchain.compile`. */
  compile?: string[];
  /** Env vars layered on top of the base spawn env (last wins on key clash). */
  env?: Record<string, string>;
}

export interface TemplateSpec {
  id: string;
  /** Short human-facing title rendered on the New Project template card. */
  label: string;
  /** One-line description rendered on the template card. Older packs instead
   * cram "Title — description" into `label`; the console's template menu
   * splits that on the em-dash as a fallback, but new packs should set this.
   * Hosts that don't understand `description` render `label` alone, so if you
   * must support such a host, keep the combined "Title — description" `label`
   * (the em-dash split then keeps modern cards correct too). */
  description?: string;
  /** Language pack id this template's project uses, when it differs from what
   * the pack implies (lang packs → the pack id; app/example packs →
   * `requires[0]`, else "deno"). Drives the card's language icon AND the
   * scaffolded project's `lang`. */
  lang?: string;
}

/**
 * The console's design-token vocabulary (nanobpmn
 * console/src/theme/tokens.css). A theme restyles the whole console by giving
 * CSS colours for these keys; missing keys fall back to the base appearance.
 */
export const THEME_TOKEN_KEYS = [
  "app",
  "panel",
  "raised",
  "inset",
  "hover",
  "edge",
  "edgeStrong",
  "text",
  "textMuted",
  "textFaint",
  "accent",
  "accentStrong",
  "accent2",
  "onAccent",
  "ok",
  "warn",
  "danger",
  "info",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/** One console colour theme a `kind: "theme"` pack contributes. Pure data. */
export interface ThemeSpec {
  /** Stable id, unique across packs (e.g. "nord-dark"). */
  id: string;
  /** Human-facing name shown in the console's theme picker. */
  label: string;
  /** Base palette the tokens override — controls color-scheme and any token
   * the theme doesn't specify. */
  appearance: "light" | "dark";
  /** Design-token name -> CSS colour. Unknown keys are ignored by the host. */
  tokens: Partial<Record<ThemeTokenKey, string>>;
}

/**
 * IntelliSense data a lang pack ships for the console's Monaco editor. The
 * console has a real language service only for TypeScript/JavaScript (Monaco's
 * built-in TS worker); every other language gets tokenisation only. A pack can
 * light up completion, hover, and signature help for its `monacoLang` by
 * shipping this curated data — no in-browser language server required. The host
 * registers one provider per `monacoLang` and feeds it every pack's entries.
 */
export interface LangIntellisense {
  /** Monaco language id these entries apply to (e.g. "csharp", "rust"). */
  monacoLang: string;
  /** Extra characters that reopen the completion popup (e.g. ["."]). The word
   * character set always triggers completion; add member-access dots etc. */
  triggerCharacters?: string[];
  /** Completion items offered in files of this language. */
  completions?: CompletionSpec[];
  /** Hover cards keyed by the exact symbol under the cursor. */
  hovers?: HoverSpec[];
  /** Signature-help entries shown while typing a call's arguments. */
  signatures?: SignatureSpec[];
}

/**
 * Monaco `CompletionItemKind` names a pack may use. The listed names are the
 * commonly-emitted ones and exist only as authoring hints — the real authority
 * is the host's kind→Monaco mapping, which renders any unknown value as
 * `Value`. The union is intentionally open (`string & {}`) because the mapping
 * lives in a separate repo (the console), so a closed set here can't be
 * compile-time reconciled with it and would only drift; keeping it open means a
 * new generator-emitted kind never breaks consumers of this package.
 */
export type CompletionKind =
  | "keyword"
  | "snippet"
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "module"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "value"
  | (string & {});

/** One completion item. `insertText` defaults to `label`. */
export interface CompletionSpec {
  /** Text shown in the completion list. */
  label: string;
  /** Icon/category. Defaults to "value" when omitted. */
  kind?: CompletionKind;
  /** Text inserted on accept. Defaults to `label`. */
  insertText?: string;
  /** When true, `insertText` is a Monaco snippet (`${1:name}` placeholders). */
  snippet?: boolean;
  /** Short right-aligned signature/type (e.g. the return type). */
  detail?: string;
  /** Markdown documentation shown in the details flyout. */
  documentation?: string;
}

/** A hover card: shown when the pointer rests on `symbol`. */
export interface HoverSpec {
  /** Exact identifier that triggers this hover (whole-word match). */
  symbol: string;
  /** Markdown rendered in the hover card. */
  contents: string;
}

/** One function/method signature surfaced by signature help. */
export interface SignatureSpec {
  /** Identifier that, when followed by `(`, triggers this help (e.g.
   * "CreateProcessInstanceAsync"). */
  trigger: string;
  /** Full signature line shown in the popup. */
  label: string;
  /** Markdown documentation for the call. */
  documentation?: string;
  /** Ordered parameters; the active one is highlighted by comma position. */
  parameters?: SignatureParam[];
}

/** One parameter within a {@link SignatureSpec}. */
export interface SignatureParam {
  /** Parameter label as it appears in the signature (e.g. "id: string"). */
  label: string;
  /** Markdown documentation for this parameter. */
  documentation?: string;
}

/**
 * One config field a pack surfaces in the console (read-only in the IDE config
 * panel; for a trigger source, the fields a trigger of this `kind` renders).
 */
export interface ConfigField {
  /** Stable key within the pack (the manifest trigger's `config[key]`). */
  key: string;
  /** Human-facing label. */
  label: string;
  /** What the field controls. */
  description?: string;
  /** Environment variable this field reads its current value from, if any. */
  env?: string;
  /** Documented default when unset. */
  default?: string;
}

/**
 * How a trigger source pack's events reach the runtime (ADR 0025 §6). Only
 * `webhook` — the universal ingress the driver POSTs to — is honoured in v1;
 * the field is forward-declared so a pack states its contract explicitly.
 */
export type SourceTransport = "webhook";

/**
 * One trigger source **kind** a `kind: "trigger"` pack contributes (ADR 0025
 * §6). Registering a `kind` lets a manifest trigger use it and the
 * console/validation recognise it. The pack's out-of-process `driver` (a
 * Node/Deno process, ADR 0038/0036) emits events over the trigger ingress; the
 * runtime owns the inbox/dispatch/retry — the pack only produces events.
 */
export interface TriggerSourceSpec {
  /** The `type` string a manifest trigger uses (e.g. "mqtt", "imap"). */
  kind: string;
  /** Human label for the console source picker. */
  displayName?: string;
  /** How the runtime receives this source's events. Defaults to "webhook". */
  transport?: SourceTransport;
  /** Config fields the console renders for a trigger of this kind. */
  configFields?: ConfigField[];
  /**
   * Pack-relative path to the out-of-process driver entrypoint (a Node/Deno
   * `.ts`/`.js`/`.mjs` file). When present, the runtime auto-launches and
   * supervises the driver while an App with a trigger of this `kind` runs
   * (ADR 0025 phase 4): one child process per such trigger, restarted with
   * backoff on crash, killed when the App stops. Absent = declaration-only.
   */
  driver?: string;
}

/**
 * One worker a connector pack contributes — the **outbound/compute** edge of the
 * I/O surface (ADR 0050, amending ADR 0033 §4). "Connector" is the *planned* pack
 * kind for two-edge I/O packs; it is not yet a member of {@link ExtKind}, so today
 * these packs ship as `kind: "trigger"` and carry `workers[]` alongside their
 * `triggerSources[]`. Where {@link TriggerSourceSpec} is the *inbound* edge
 * (external event → engine), a worker is the *outbound* edge (engine job →
 * external effect, e.g. "post a Slack message").
 *
 * The `type` is the design→runtime **seam**: it must equal the
 * `zeebe:taskDefinition:type` of the element template (a {@link ExtManifest.components}
 * entry) that this worker backs, so a task dragged from the palette resolves to
 * a running worker (ADR 0033 §1). The worker is **long-lived**: it subscribes by
 * `type` (Zeebe-style, via `@nanobpm/worker`'s `defineWorker`), is started when
 * the connector is enabled and the App runs, and is supervised — restarted with
 * backoff on crash, killed on stop — reusing the trigger-driver supervisor
 * (ADR 0025 §4 / 0036 / 0038). At-least-once outbound delivery is inherited from
 * the engine's durable job queue (the job *is* the outbox), so no new durable
 * subsystem is needed — the symmetric dual of the inbound inbox (ADR 0025 §2).
 */
export interface WorkerSpec {
  /** The BPMN job type this worker serves. MUST equal the backing element
   * template's `zeebe:taskDefinition:type` (the design→runtime seam). */
  type: string;
  /** Pack-relative entrypoint (a Node/Deno `.ts`/`.js`/`.mjs`) that calls
   * `@nanobpm/worker`'s `defineWorker`. Runs on Node >=22.6
   * (`--experimental-strip-types`) or Deno, like a trigger driver. */
  entry: string;
  /** Human label for the console. */
  displayName?: string;
  /** Max concurrent jobs (maps to `defineWorker`'s `maxParallelJobs`). */
  maxParallelJobs?: number;
  /** Job lock timeout, ms (maps to `defineWorker`'s `timeoutMs`; issue #596): how long the
   *  engine leases an activated job to this worker before re-activating it elsewhere. Set it
   *  above the handler's worst-case runtime for long-running outbound calls. The pack's
   *  `defineWorker({ timeoutMs })` overrides this design-time default when both are set. */
  timeoutMs?: number;
  /**
   * Config fields surfaced **per-connector** in the project config surface when
   * the connector is enabled — e.g. the shared connection/API token. Defaults
   * are env-pointers (`env`), never inline secrets, so the committed manifest
   * carries no credentials (ADR 0027 §5). Distinct from the element template's
   * per-instance `zeebe:input` fields (channel, message text).
   */
  configFields?: ConfigField[];
}

export interface ExtManifest {
  id: string;
  kind: ExtKind;
  displayName: string;
  /** Optional pack icon: an inline SVG XML string (preferred; use single-quoted
   * attributes so it nests in JSON) or a data:/http: URL. Lang packs supply this
   * so the console can badge project cards with a language icon. */
  icon?: string;
  fileTypes?: FileType[];
  templates?: TemplateSpec[];
  toolchain?: Toolchain;
  /** example/app packs: lang pack ids required to build/run this pack's
   * projects. The FIRST entry sets the scaffolded project's language — which
   * drives the host's run/compile toolchain — so any app or example pack that
   * isn't Deno-based must declare it (else new projects fall back to the Deno
   * runtime). Required for example packs; required for app packs whose
   * toolchain declares a detect probe. */
  requires?: string[];
  /** example packs: subdir holding the ready-to-copy project. */
  appDir?: string;
  /** example packs: one-line description for the picker. */
  summary?: string;
  /** theme packs: the console colour themes this pack contributes. */
  themes?: ThemeSpec[];
  /** lang packs: curated IntelliSense (completion/hover/signature) for the
   * pack's languages, since the console has no in-browser language server for
   * anything but TypeScript. One entry per `monacoLang`. */
  intellisense?: LangIntellisense[];
  /** Built-in packs set this; published packs omit it. */
  builtin?: boolean;
  /** trigger packs: the trigger source kinds this pack contributes (ADR 0025
   * §6). Each entry registers a `type` a manifest trigger can use; the pack's
   * out-of-process driver emits events over the trigger ingress. */
  triggerSources?: TriggerSourceSpec[];
  /**
   * Pack-relative paths to Camunda **element-template** JSON files (each a
   * single template or an array of them) — the design-time **components** this
   * pack contributes to the modeler palette (ADR 0033 §4). The host resolves +
   * parses them (`extensions::pack_component_templates`, path-escape-guarded)
   * and layers them into the palette / template chooser. Mirrors the host's
   * `ExtManifest.components: Vec<String>`.
   */
  components?: string[];
  /**
   * connector packs: the **workers** this pack contributes — the outbound edge
   * bound to its `components` element templates by matching job `type` (ADR
   * 0050, amending ADR 0033 §4). Host consumption (launch + supervision +
   * project-enablement gating) is the ADR 0050 host increment; the field is the
   * canonical contract packs author against.
   */
  workers?: WorkerSpec[];
  /**
   * Guided journeys this pack contributes (ADR 0049 §7) — short, outcome-shaped
   * onboarding paths offered in the console's journey picker.
   *
   * This is how onboarding scales with the pack ecosystem rather than living in a
   * hardcoded list in the console: a pack that adds a capability can teach it.
   * A pack journey is only ever offered when its pack is installed, which falls
   * out of it being a pack journey.
   */
  tours?: TourSpec[];
  /**
   * app packs that front an out-of-process CLI (e.g. this Urban pack →
   * `@nanobpm/urban`'s `urban`/`create-urban-app` bins): opt in to a guarded
   * `npm install` inside the pack after it is fetched, so its runtime
   * dependencies' `node_modules/.bin/*` are materialised (an `npm pack` tarball
   * ships `package.json` but not `node_modules`). Mirrors the host's
   * `ExtManifest.install_deps: bool`. The host installs `--omit=dev`
   * `--ignore-scripts` (until the pack is trusted); default/absent is a pure
   * pack+extract with no network install.
   */
  installDeps?: boolean;
}

/**
 * A named gate from the console's shared precondition library
 * (`lib/tour/preconditions.ts`).
 *
 * A pack ships **data, never code**, so it cannot supply the predicate functions
 * the console's own journeys use — it names one of these and the console resolves
 * it. Deliberately a closed set: an open expression language here would be a
 * second, weaker copy of the precondition library, and would drift from it.
 *
 * - `hasJsRuntime` — Node or Deno is present, so Run can actually start something.
 * - `hasProject` — at least one project exists.
 * - `hasCluster` — more than one node, so the cluster views show something real.
 * - `hasTraces` — traces have been captured.
 */
export type TourGate =
  | "hasJsRuntime"
  | "hasProject"
  | "hasCluster"
  | "hasTraces";

/**
 * Which affordance a step renders as.
 *
 * - `spotlight` (the default) — highlights the `data-tour` anchor in `selector`.
 * - `note` — anchorless, centered framing with nothing to point at.
 * - `handoff` — a copyable terminal command or URL, for a step whose work happens
 *   outside the console.
 */
export type TourStepKind = "spotlight" | "note" | "handoff";

/** One step of a pack-contributed journey. */
export interface TourStepSpec {
  /** Stable across edits — this is the analytics key. */
  id: string;
  /** Defaults to `spotlight`, so the common case needs no boilerplate. */
  kind?: TourStepKind;
  title: string;
  body: string;
  /** Absolute console path to navigate to before showing the step. */
  route?: string;
  /** Gate for this step. `hasJsRuntime`/`hasCluster` can demand a `repair`. */
  precondition?: TourGate;
  /**
   * Shown **instead** when `precondition` is not satisfied but the target is
   * still present — e.g. "here is how to install a runtime" rather than a step
   * telling the user to press Run on a host where Run cannot work. Without a
   * `repair`, such a step is skipped rather than shown, because showing it would
   * assert exactly what the precondition just ruled out. A repair step does not
   * nest: a `repair` inside a `repair` is rejected at publish time, and ignored
   * by the console as a safety net if one ever slips through.
   */
  repair?: TourStepSpec;
  /** Advisory: a step whose absence does not weaken the journey. */
  optional?: boolean;
  /** `spotlight`: the `data-tour` anchor to highlight, e.g. `[data-tour="run"]`. */
  selector?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /**
   * `handoff`: the command or URL offered for copying.
   *
   * **Requires a trusted pack.** A handoff's `copy` is a command the user is
   * invited to paste into a shell, so the host strips handoff steps from
   * untrusted packs before they ever reach the browser (and drops a journey left
   * with no steps). Nothing is ever executed by the console — it renders this as
   * inert text — but that is not a reason for an untrusted pack to put arbitrary
   * text where a user expects a trustworthy command. Spotlight and note steps
   * need no trust.
   */
  copy?: string;
  /** `handoff`: button label. Defaults to "Copy". */
  copyLabel?: string;
  /**
   * `handoff`: auto-advance once an external worker is seen polling this job
   * type. The only verification a pack can declare, because it is the only one
   * expressible without code. Absent means the user self-reports ("I've done
   * it") — honest, since the console cannot watch a terminal.
   */
  verifyPollingJobType?: string;
}

/** A guided journey a pack contributes. Keep it to five steps or fewer. */
export interface TourSpec {
  /** Stable, unique across installed packs. */
  id: string;
  title: string;
  /** One line for the journey-picker card. */
  blurb: string;
  /**
   * Console profiles this journey is offered in. Empty (or omitted) means
   * `studio` only — the conservative default, since most pack capabilities are
   * authoring surfaces the lean operator build does not ship.
   */
  profiles?: ("studio" | "observe")[];
  /** Journey-level gates: not offered at all unless every one is satisfied. */
  preconditions?: TourGate[];
  steps: TourStepSpec[];
  /**
   * What must actually have happened for the journey to have worked. Omit for an
   * orientation-only journey: the console then records completion without
   * claiming an outcome, exactly as its own overview journey does.
   */
  successWhen?: TourGate;
}

export const MANIFEST_FILE = "nano-ide.ext.json";
