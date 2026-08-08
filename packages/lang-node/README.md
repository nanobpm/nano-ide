# @nanobpm/nano-ide-lang-node

A **Node.js / TypeScript** language pack for the [Nano RAD IDE](https://nanobpm.io).

It adds a first-class TypeScript/JavaScript authoring experience that runs on the
**local Node runtime** — no Deno required. This matters on hosts where Deno has
no build, most notably **32-bit ARM (Raspberry Pi 2B and friends)**: Node ships an
official `linux-armv7l` binary (and the c8ctl npm launcher *is* Node), so JS/TS
workers run there even though Deno cannot.

> Nano's built-in TypeScript runtime is Deno, and it already falls back to Node
> transparently when Deno is absent (ADR 0036). This pack is the **explicit,
> npm-native alternative**: a real `package.json` + `tsconfig.json` project using
> the official Camunda 8 JS SDK, with a Node toolchain the console drives
> directly — parallel to the `lang-python` and `lang-rust` packs.

## What it contributes

- **File types:** `.ts`, `.mts`, `.js`, `.mjs` (Monaco's built-in TypeScript
  language service provides completion/hover/signature help — no extra
  IntelliSense payload is shipped).
- **Toolchain:**
  - **Run** → `npm start` → `node --experimental-strip-types --no-warnings main.ts`
    (runs `.ts` directly; requires **Node ≥ 22.6**).
  - **Compile / typecheck** → `npm run typecheck` → `tsc --noEmit`.
  - Both npm scripts have an `npm install` pre-hook, so dependencies are fetched
    automatically on first Run/Typecheck (like `uv run` / `cargo run`).
- **Starter template (`node-starter`):** a complete, runnable Camunda 8 app on the
  official [`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api)
  SDK — connect, deploy a BPMN, register a `hello` job worker, create an instance.
  Against a Nano gateway the SDK transparently upgrades to the command-stream /
  Falcon transport; the same code runs on plain REST against stock Camunda 8.

## Requirements

- **Node ≥ 22.6** on the host (for `--experimental-strip-types`, built-in
  `WebSocket`, and `node:sqlite`). Older Node is treated as absent.

## Install

Install it as a Nano IDE extension pack (the console's Extensions view), or add it
to a project's pack set. The console reads `nano-ide.ext.json` and surfaces the
language + starter template.

## Licence

Apache-2.0.
