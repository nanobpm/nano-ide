# @nanobpm/nano-ide-lang-csharp

C# / .NET language pack for the [Nano RAD IDE](https://github.com/nanobpm/nano-ide).

- **Grammar**: `.cs` → Monaco `csharp`, `.csproj` → `xml`.
- **Toolchain**: `dotnet` — in the Nano IDE, press **▶ Run** (which runs
  `dotnet run -c Release`, restoring NuGet dependencies and running in one step);
  `dotnet build -c Release` is the compile step. Projects target whichever .NET
  SDK is installed (the framework major is derived from the running SDK), so a
  developer on .NET 10 builds `net10.0` without pinning an older framework.
- **Template** `csharp-starter`: a complete, runnable Camunda 8 app — connects,
  prints the gateway topology, deploys `resources/processes/starter.bpmn`, creates
  one process instance, and runs a job worker for the `hello` service task using the
  official [`Camunda.Orchestration.Sdk`](https://www.nuget.org/packages/Camunda.Orchestration.Sdk).

## Zero-code path to Falcon

The SDK auto-detects a Nano gateway (`GET /v2/topology`) and transparently upgrades
process-instance creation and job push to the command-stream / Falcon transport.
The same `Program.cs` runs on plain REST against stock Camunda 8 — no code change.

## Install

Installed into the Nano IDE's extension directory (see the console's Extensions
view). Requires the .NET SDK 8.0+ on `PATH`; the pack surfaces install guidance
when `dotnet` is missing.
