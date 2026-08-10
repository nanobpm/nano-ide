// Delegate for `GET /greetings` (operationId `listGreetings`).
//
// The `api` binding in nano.app.json points at `openapi.yaml`; Urban derives the route, the typed
// request/response contract, a runtime validator, AND a generated controller that type-checks this
// delegate against the spec (ADR 0059) — so its signature and response shape cannot drift. You write
// only the implementation. Import the typed `defineOperation` + row types from `nano-generated/`
// (produced by `urban gen`); the delegate returns `{ status, body }` and the runtime serializes
// `body` as JSON. Docs are served for free at `/app/api-docs`.

import type { Greeting } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("listGreetings", (_input, app) => {
	const greetings = app.data.repo("greeting").all<Greeting>();
	return { status: 200, body: { greetings } };
});
