# @nanobpm/nano-ide-app-embedded-graalvm-native

A **GraalVM Native Image** variant of the [Embedded Nano (JVM)](https://www.npmjs.com/package/@nanobpm/nano-ide-app-embedded-jvm)
app pack for the [Nano RAD IDE](https://nanobpm.io).

Same Bernd-in-JVM code (ADR 0005) — the Nano BPMN engine embedded in-process,
driven by an outer stock Camunda REST job worker — but compiled with **GraalVM
Native Image** to a single **standalone binary (~30 MB, no JDK required at
runtime)**.

## What it contributes

- **File types:** `.java` (Monaco's Java language service).
- **Starter template (`embedded-graalvm-starter`) — "KYC microservice (GraalVM
  native)":** the same demo as the JVM pack, packaged as a native executable.
- **Toolchain (Maven + GraalVM):**
  - **Compile** → `mvn -Pnative -DskipTests package` (native image build).
  - **Run** → the produced `microservice/target/kyc-microservice` binary
    directly — no `java -jar`, no JDK on the target.

## Why native

Instant start-up and a small, self-contained footprint: ship one ~30 MB binary
instead of a JDK plus jars. Ideal for containers, edge, and cold-start-sensitive
deployments.

## Requirements

- **Java** (the pack `requires` the `java` lang pack), **Maven** (`mvn`), and a
  **GraalVM** toolchain capable of building native images.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the native
template.

## Licence

Apache-2.0.
