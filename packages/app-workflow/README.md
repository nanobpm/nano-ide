# @nanobpm/nano-ide-app-workflow

A **code-first durable workflow** app pack for the [Nano RAD IDE](https://nanobpm.io).

It scaffolds durable workflow apps built on [`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow),
where the **executable BPMN model is derived from ordinary async code** (ADR
0044 / 0045). You write TypeScript; the process model — and its durable,
replay-safe execution — comes from it. No diagram to hand-draw and keep in sync.

## What it contributes

Two starter templates:

- **`workflow-starter` — Durable workflow (imperative):** replay-based durable
  execution. Write the flow as straight-line async code; each step is
  checkpointed so the workflow survives restarts and resumes where it left off.
- **`workflow-flow-starter` — Durable workflow (declarative):** a declarative
  `defineFlow` shape with a **human-in-the-loop signal** — the workflow parks
  waiting for an external signal, then continues.

Both derive their executable model from the code itself — a single source of
truth, no drift between diagram and implementation.

## Requirements

- The **Deno** runtime (Nano's built-in TypeScript runtime). The console runs
  the app directly; `@nanobpm/workflow` is fetched on first run.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers both
workflow templates.

## Licence

Apache-2.0.
