# @nanobpm/nano-ide-example-csharp-throughput

A distributable **C# throughput demo** for the [Nano RAD IDE](https://nanobpm.io).

A parallel producer flood plus a `JobWorker`, built on the official
[`Camunda.Orchestration.Sdk`](https://www.nuget.org/packages/Camunda.Orchestration.Sdk).
**One code path** runs against **Camunda 8 (REST)** or **Nano (Falcon)** — the
SDK upgrades the transport transparently. It streams live **creates/s** and
**completes/s** so you can watch throughput in real time.

## What it shows

- The **same worker code** against stock Camunda 8 and against Nano, with no
  branch in the app — only the gateway it points at changes.
- Where the **command-stream / Falcon** transport pulls ahead of plain REST.

## What it contributes

- **Example template (`csharp-throughput`):** the full runnable app under `app/`,
  installed as a project from the console.

## Requirements

- The **`csharp`** lang pack (declared in `requires`) and a **.NET** toolchain on
  the host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo as
a distributable example app.

## Licence

Apache-2.0.
