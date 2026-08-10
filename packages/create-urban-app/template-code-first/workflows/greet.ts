// The `greet` process, authored code-first with `defineFlow` (ADR 0044/0045).
//
// Instead of an authored `processes/*.bpmn`, the executable model is DERIVED from
// this TypeScript: `@nanobpm/urban` (via `@nanobpm/workflow`) turns the flow tree
// below into BPMN, job types and message names. `main.ts` deploys the derived
// model and hosts the `w.run` handler in an in-process `Worker`.
//
// A `w.run` step runs inside `@nanobpm/workflow`'s Worker, which receives the job
// but no Urban `AppApi`. To reach the datasource, `main.ts` injects the Urban data
// layer via `setGreetData(app.data)` before the Worker starts.
//
// Typed data `envelope`s give the step's `job.variables` (in) and return value
// (out) real TypeScript types, and are lifted into the generated BPMN as a
// `nano:shape` + `dataEnvelope` — so the model stays ejectable to model-first.

import type { DataLayer, Table } from "@nanobpm/urban";
import { defineFlow, envelope } from "@nanobpm/urban";

/** What starts a greeting. */
const GreetIn = envelope("GreetIn", { who: "string" });
/** What the step completes with. */
const GreetOut = envelope("GreetOut", { message: "string" });

interface Greeting {
	id?: number;
	who: string;
	message: string;
	createdAt?: string;
}

let _data: DataLayer | null = null;

/** Injected by `main.ts` after the Urban runtime provisions the datasource. */
export function setGreetData(d: DataLayer): void {
	_data = d;
}

function greetings(): Table<Greeting> {
	if (!_data) {
		throw new Error(
			"data layer not injected — call setGreetData(app.data) before starting the Worker",
		);
	}
	return _data.table<Greeting>("greetings", "id");
}

/**
 * The `greet` flow, with a single `hello` step that writes a greeting row and
 * completes with `{ message }`. Start an instance with
 * `WorkflowClient.start(greet, { who })` (see scripts/greet.ts).
 */
export const greet = defineFlow(
	"greet",
	{ hello: { in: GreetIn, out: GreetOut } },
	(w) => {
		// `job.variables` is typed `{ who: string }`; the return is checked against `{ message: string }`.
		// The step name must differ from the flow id ("greet"), which is reserved for the process itself.
		w.run("hello", async (job) => {
			const who = job.variables.who || "world";
			const message = `Hello, ${who}!`;
			await greetings().insert({
				who,
				message,
				createdAt: new Date().toISOString(),
			});
			return { message };
		});
	},
);
