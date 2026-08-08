# @nanobpm/nano-ide-example-java-throughput

A distributable **Java + Maven throughput demo** for the [Nano RAD IDE](https://nanobpm.io).

A producer plus a `JobWorker` that maxes out create / complete throughput. The
**same code** runs against **Camunda 8** or **Nano** over four transport combos.
A Maven **profile** picks the client shim (`-Pstock` vs `-Pfalcon`) and a **run
argument** picks the wire, so one code path covers all four:

## What it shows

- One worker, **four transport combos**, selected via **run configurations**
  (profile + run arg):
  - **Camunda 8 · REST** — `-Pstock` (default)
  - **Camunda 8 · gRPC** — `-Pstock`, arg `grpc`
  - **Nano · REST** — `-Pfalcon`, arg `rest`
  - **Nano · Falcon** — `-Pfalcon` (default)
- Where the **command-stream / Falcon** transport pulls ahead of REST and gRPC.

## What it contributes

- **Example template (`java-throughput`):** the full runnable Maven app under
  `app/`, installed as a project from the console.
- **Toolchain (Maven):** `mvn package` / `mvn compile exec:java`, with the four
  run configurations above.

## Requirements

- The **`java`** lang pack (declared in `requires`) and **Maven** (`mvn`) on the
  host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo
with its REST / gRPC / Falcon run configurations.

## Licence

Apache-2.0.
