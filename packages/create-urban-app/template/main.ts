// Entrypoint for __APP_NAME__. Runs the Urban runtime against a Nano engine.
//
// Configure the engine address with CAMUNDA_REST_ADDRESS (default http://localhost:8080/v2).
// Run with: npm start          (or: npx urban run)
//
// `app.log` is an app-level structured logger (NDJSON on stdout/stderr). Worker handlers and
// API route delegates get their own `app.log` via the injected `AppApi`, auto-tagged with the
// job/request they belong to. Set URBAN_LOG_LEVEL=debug to see debug lines.

import { runFromEnv } from "@nanobpm/urban";

const app = await runFromEnv({ root: import.meta.dirname ?? "." });
const info = app.inspect();
app.log.info("started", { name: info.name, httpPort: info.httpPort ?? null });
