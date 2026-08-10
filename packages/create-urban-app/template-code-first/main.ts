// Entrypoint for __APP_NAME__ (code-first). Runs the Urban runtime against a Nano
// engine, then deploys the code-first `greet` flow and hosts its worker in-process.
//
// Configure the engine address with CAMUNDA_REST_ADDRESS (default http://localhost:8080/v2).
// Run with: npm start        (hot reload: npm run dev)
//
// Unlike a model-first app (`urban run` deploys authored .bpmn and hosts manifest
// workers), a code-first app owns process deployment and worker hosting itself:
// `@nanobpm/urban` derives the model from `defineFlow`, `WorkflowClient` deploys it,
// and `@nanobpm/workflow`'s `Worker` runs the `w.run` handlers.
import { runFromEnv, selectHost, Worker, WorkflowClient } from "@nanobpm/urban";
import { greet, setGreetData } from "./workflows/greet.ts";

const REST = process.env.CAMUNDA_REST_ADDRESS ?? "http://localhost:8080/v2";
// The workflow client + worker take the base REST address without the `/v2` suffix.
const BASE_URL = REST.replace(/\/v2\/?$/, "");

// 1) Urban provisions the datasource + surfaces. The manifest declares no models or
//    workers, so `deploy`/`workers` mount nothing — the code-first surface below owns
//    process deployment and worker hosting.
const app = await runFromEnv({
	host: selectHost(),
	restAddress: REST,
	root: import.meta.dirname ?? ".",
});
if (!app.data) throw new Error("Urban data layer was not provisioned");

// Wire the provisioned data layer into the in-process `greet` handler.
setGreetData(app.data);

// 2) Deploy the derived BPMN and host the `w.run` handler in-process.
const client = new WorkflowClient({ baseUrl: BASE_URL });
await client.deploy(greet);

const worker = new Worker({
	baseUrl: BASE_URL,
	workflows: [greet],
	onError: (err) => app.log.error("worker error", { error: String(err) }),
});
worker.start();

const info = app.inspect();
app.log.info("started (code-first)", {
	name: info.name,
	httpPort: info.httpPort ?? null,
	flow: greet.id,
	baseUrl: BASE_URL,
});
app.log.info("start a greeting with: npm run greet -- Adam");

// ── graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function drainAndExit(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	app.log.info("shutting down");
	try {
		await worker.stop();
	} catch {
		/* worker never fully started */
	}
	try {
		await app.stop();
	} catch {
		/* already stopped */
	}
	process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => void drainAndExit());
}
