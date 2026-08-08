# @nanobpm/nano-ide-app-embedded-jvm

An **Embedded Nano (JVM)** app pack for the [Nano RAD IDE](https://nanobpm.io).

It scaffolds an app that runs the **Nano BPMN engine in-process inside the JVM**
via [`io.github.jwulf:nano-bernd`](https://central.sonatype.com/artifact/io.github.jwulf/nano-bernd),
driven by an **outer stock Camunda REST job worker** (ADR 0005). The inner Bernd
engine serves an outer BPMN task — the same pattern works against Camunda 8
SaaS, Self-Managed, or a Nano gateway.

## What it contributes

- **File types:** `.java` (Monaco's Java language service).
- **Starter template (`embedded-jvm-starter`) — "KYC microservice":** a Maven
  project where an inner Bernd engine, embedded in the JVM, fulfils a task
  claimed by an ordinary outer Camunda REST worker.
- **Toolchain (Maven):**
  - **Run** → `mvn compile exec:java` on `microservice/pom.xml`.
  - **Compile** → `mvn -DskipTests package`.

## Requirements

- **Java** (the pack `requires` the `java` lang pack) and **Maven** (`mvn`) on
  the host. Without Maven the app pack's toolchain probe reports it as absent.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the
**KYC microservice** template on the JVM runtime.

## Licence

Apache-2.0.
