# @nanobpm/nano-ide-example-rust-throughput

A distributable **native Rust throughput demo** for the [Nano RAD IDE](https://nanobpm.io).

A native, **pipelined** producer plus a `JobWorker`, built on the official
[`camunda-orchestration-sdk`](https://crates.io/crates/camunda-orchestration-sdk).
**One code path** runs against **Camunda 8 (REST)** or **Nano** — the SDK
auto-detects a Nano gateway and upgrades `create_process_instance` to its
credit-metered **command-stream** producer transparently, while the same code
runs on plain REST against stock Camunda. A high-concurrency pipelined producer
is what makes this the highest-throughput example in the set: it shows where the
**command stream beats REST**.

## What it shows

- The throughput headroom of a **pipelined producer** on the command stream
  versus request/response REST.
- The **same worker code** against stock Camunda 8 and against Nano, with no
  branch in the app — only the gateway it points at changes.

## What it contributes

- **Example template (`rust-throughput`):** the full runnable Cargo app under
  `app/`, installed as a project from the console.

## Requirements

- The **`rust`** lang pack (declared in `requires`) and a **Rust / Cargo**
  toolchain on the host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo as
a distributable example app.

## Licence

Apache-2.0.
