// Delegate for `POST /greetings` (operationId `createGreeting`).
//
// This is the API entrypoint of the end-to-end demo. It publishes the greet message
// instead of writing the row directly, so the whole pipeline runs:
//
//   POST /greetings ─▶ engine.publishMessage ─▶ greet.bpmn (message start)
//                    ─▶ workers/greet.ts inserts a row ─▶ GET /greetings shows it.
//
// It returns 202 Accepted (the work happens asynchronously in the process). The request
// body is validated against the spec's `GreetRequest` schema before it reaches this
// delegate, so `who` is present; we still narrow defensively (no `as` casts — see AGENTS.md).
// The typed `defineOperation` comes from `nano-generated/` (produced by `urban gen`): it types the
// request/response from the spec and lets the generated controller type-check this delegate so it
// cannot drift from the contract (ADR 0059).

import { defineOperation } from "../nano-generated/operations.ts";

function readWho(body: unknown): string {
	if (body && typeof body === "object") {
		const who = Reflect.get(body, "who");
		if (typeof who === "string" && who.trim().length > 0) return who.trim();
	}
	return "world";
}

export default defineOperation("createGreeting", async ({ body }, app) => {
	const who = readWho(body);
	// `app.log` here is auto-tagged with { method, path, operationId } for this request.
	app.log.info("greeting requested", { who });
	await app.engine.publishMessage({
		name: "__APP_ID__.greet-requested",
		correlationKey: who,
		variables: { who },
	});
	return { status: 202, body: { accepted: true, who } };
});
