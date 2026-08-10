// Starter e2e test for your Urban app, powered by @nanobpm/urban-testkit.
//
// It runs the shared engine contract against the in-process WASM engine — no
// server, no wall-clock waits, CI-friendly. This pins the exact engine seam your
// workers and processes run on. As the test kit grows (bootTestApp, the settle
// loop, generated HTTP drivers), add app-specific process/worker/UI tests here.
//
// Run it with `npm test` (Node) or `deno task test` (Deno).

import { createWasmEngineClient, runEngineClientContract } from "@nanobpm/urban-testkit";

runEngineClientContract("wasm", () => createWasmEngineClient());
