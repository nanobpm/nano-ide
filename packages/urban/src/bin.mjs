#!/usr/bin/env node
// Bootstrap for the `urban` CLI. Runs the compiled CLI (dist/cli.js). The package is
// published as compiled JS + .d.ts because Node cannot strip types for files under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so no type-stripping flag
// is needed here.
//
// The CLI is loaded IN-PROCESS (dynamic import + runCli) rather than spawned as a second
// Node: a spawn doubled the start-up cost of every command, and the gateway runs `urban
// data` once per data op (nano-ide#589, nano-bpm#1340). dist/cli.js only auto-runs when it
// is argv[1] itself, so importing it here does not start it twice.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let runCli;
try {
  ({ runCli } = await import(pathToFileURL(cli).href));
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
// runCli owns the exit code, stdio flushing and long-running commands (run/dev).
await runCli(process.argv.slice(2));
