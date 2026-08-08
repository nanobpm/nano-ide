# @nanobpm/nano-ide-lang-python

Python language pack for the [Nano RAD IDE](https://github.com/nanobpm/nano-ide).

- **Grammar**: `.py` → Monaco `python`.
- **Toolchain**: [`uv`](https://docs.astral.sh/uv/) — `uv run main.py` provisions a
  Python 3.10+ interpreter and installs dependencies from `pyproject.toml` in one
  step (no manual venv). `uv sync` is the compile step.
- **Template** `python-starter`: a complete, runnable Camunda 8 app — connects,
  prints the gateway topology, deploys `resources/processes/starter.bpmn`, creates
  one process instance, and runs a job worker for the `hello` service task using the
  official [`camunda-orchestration-sdk`](https://pypi.org/project/camunda-orchestration-sdk/).

## Zero-code path to Falcon

The SDK auto-detects a Nano gateway (`GET /v2/topology`) and transparently upgrades
process-instance creation and job push to the command-stream / Falcon transport.
The same `main.py` runs on plain REST against stock Camunda 8 — no code change.

## Install

Installed into the Nano IDE's extension directory (see the console's Extensions
view). Requires `uv` on `PATH`; the pack surfaces install guidance when it is
missing.
