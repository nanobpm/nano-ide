# @nanobpm/nano-ide-app-deno-gui

A **Deno GUI** app pack for the [Nano RAD IDE](https://nanobpm.io).

It scaffolds a process application that **serves its own UI** — a single Deno
binary that stands up an HTTP server (`Deno.serve`) and hands out a browser
front-end alongside the workflow logic. One artefact, no separate web server to
deploy.

## What it contributes

- **Starter template (`gui-starter`):** a served-UI binary built on
  `Deno.serve` — the http entrypoint, a minimal UI, and the wiring to talk to a
  Nano / Camunda 8 gateway. Run it and open the served page in a browser.

## Requirements

- The **Deno** runtime (Nano's built-in TypeScript runtime). No extra
  toolchain: the console runs the app directly.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the **GUI
app** template.

## Licence

Apache-2.0.
