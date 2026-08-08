# @nanobpm/nano-ide-example-python-throughput

A distributable **Python throughput demo** for the [Nano RAD IDE](https://nanobpm.io).

An async producer flood plus a `JobWorker`, built on the official
[`camunda-orchestration-sdk`](https://pypi.org/project/camunda-orchestration-sdk/).
**One code path** runs against **Camunda 8 (REST)** or **Nano (Falcon)** — the
SDK upgrades the transport transparently. It streams live **creates/s** and
**completes/s** so you can watch throughput in real time.

## What it shows

- The **same worker code** against stock Camunda 8 and against Nano, with no
  branch in the app — only the gateway it points at changes.
- Where the **command-stream / Falcon** transport pulls ahead of plain REST.

## What it contributes

- **Example template (`python-throughput`):** the full runnable app under `app/`,
  installed as a project from the console.

## Requirements

- The **`python`** lang pack (declared in `requires`) and a **Python** runtime on
  the host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo as
a distributable example app.

## Licence

Apache-2.0.
