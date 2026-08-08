# @nanobpm/nano-ide-app-embedded-nano

An **Embedded μ-nano** app pack for the [Nano RAD IDE](https://nanobpm.io).

It scaffolds a **self-contained Deno binary with the Nano BPMN engine running
in-process** (ADR 0005) — no gateway, no broker, no network. The engine *is*
your app: deploy one binary and it runs the process itself.

## What it contributes

- **Starter template (`embedded-starter`):** a single Deno binary that embeds
  the Nano engine (via the published `@nanobpm/engine-wasm`), deploys a BPMN
  model, and drives it entirely in-process. Nothing to connect to.

## Why embedded

The regular templates talk to a **gateway**; this one removes it. That is ideal
for edge / offline / single-tenant deployments where a full gateway is overkill
— the whole workflow runtime ships as one executable.

## Requirements

- The **Deno** runtime (Nano's built-in TypeScript runtime) to build and run the
  binary.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the
**Embedded engine** template.

## Licence

Apache-2.0.
