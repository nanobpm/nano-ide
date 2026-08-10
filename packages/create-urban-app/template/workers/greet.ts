// Worker for the `__APP_ID__.greet` service task.
//
// A worker module can export its handler in three ways (the runtime resolves in order):
//   1. a `handlers` map keyed by job type,
//   2. a named export matching the job type or its last dotted segment (used here: `greet`),
//   3. a `default` function.
//
// The handler receives the job and the app API: `app.data` (typed datasource),
// `app.engine`, `app.env`, `app.log`. Return a map to complete the job with variables.
//
// `app.log` is a structured logger auto-tagged with this job's correlation context
// ({ jobKey, jobType, processInstanceKey, elementId }), so every line ties back to the
// instance that produced it. Use `app.log.info/warn/error/debug(msg, fields)` and
// `app.log.child(bindings)` to bind more context for a scope.

import type { AppApi, EngineJob } from "@nanobpm/urban";

export async function greet(
	job: EngineJob,
	app: AppApi,
): Promise<Record<string, unknown>> {
	const who = String(job.variables.who ?? "world");
	const message = `Hello, ${who}!`;

	try {
		const repo = app.data.repo("greeting");
		repo.insert({ who, message, createdAt: new Date().toISOString() });
	} catch (err) {
		app.log.error("failed to persist greeting", { who, error: String(err) });
		throw err;
	}

	app.log.info("greeted", { who });
	return { message };
}
