// runFromEnv — the one-call entrypoint a scaffolded app's main and the `urban run` CLI both
// use: select the host for the current runtime, build the nano-sdk engine client from env,
// create the Urban app, start it, and install a graceful-shutdown handler.

import { createUrbanApp, type CreateUrbanAppOptions, type UrbanApp } from "./core/runtime.ts";
import { selectHost } from "./adapters/detect.ts";
import { denoGlobal, processGlobal } from "./adapters/globals.ts";
import { createNanoSdkEngineClient } from "./engine/nanosdk.ts";
import type { EngineClient } from "./core/host.ts";

export interface RunOptions extends Partial<CreateUrbanAppOptions> {
  /** App root. Default ".". */
  root?: string;
  /** Engine REST base. Default $CAMUNDA_REST_ADDRESS or http://localhost:8080/v2. */
  restAddress?: string;
  /**
   * Engine transport passed to `@nanobpm/nano-sdk`: "auto" (default) upgrades
   * process-instance creation and job serving to the Falcon protocol on a Nano
   * server and falls back to REST elsewhere; "falcon" forces it; "rest" never
   * upgrades; "embedded" runs an in-process engine. Overridable via $CAMUNDA_TRANSPORT.
   */
  transport?: string;
  /** Install SIGINT/SIGTERM handlers to stop the app. Default true. */
  handleSignals?: boolean;
}

export async function runFromEnv(opts: RunOptions = {}): Promise<UrbanApp> {
  const host = opts.host ?? selectHost({ cwd: opts.root });
  const restAddress =
    opts.restAddress ?? host.env("CAMUNDA_REST_ADDRESS") ?? "http://localhost:8080/v2";
  const transport = opts.transport ?? host.env("CAMUNDA_TRANSPORT") ?? "auto";

  const engine: EngineClient =
    opts.engine ??
    (await createNanoSdkEngineClient({
      restAddress,
      token: host.env("CAMUNDA_TOKEN"),
      transport,
      log: host.log,
    }));

  const app = await createUrbanApp({
    host,
    engine,
    // The host is anchored at opts.root (cwd), so its APIs are already
    // root-relative; passing opts.root here as well would double-prefix every
    // path (e.g. "<root>/<root>/nano.app.json"). Keep root "." for the app.
    root: ".",
    manifest: opts.manifest,
    manifestPath: opts.manifestPath,
    port: opts.port,
    hostname: opts.hostname,
    mount: opts.mount,
    templates: opts.templates,
  });
  await app.start();

  if (opts.handleSignals !== false) installSignalHandlers(() => app.stop());
  return app;
}

export function installSignalHandlers(stop: () => Promise<void>): void {
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    // Neither Deno.addSignalListener nor process.on awaits the callback, so a
    // rejection from stop() would surface as an unhandled rejection during
    // shutdown. Register a non-async listener and swallow/log any rejection.
    Promise.resolve()
      .then(stop)
      .catch((err) => {
        try {
          console.error("error during shutdown:", err);
        } catch {
          /* ignore logging failures during teardown */
        }
      });
  };
  const deno = denoGlobal();
  const proc = processGlobal();
  if (deno?.addSignalListener) {
    try {
      deno.addSignalListener("SIGINT", onSignal);
      deno.addSignalListener("SIGTERM", onSignal);
    } catch {
      /* signal listeners may be unavailable (e.g. Windows) */
    }
  } else if (proc?.on) {
    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
  }
}
