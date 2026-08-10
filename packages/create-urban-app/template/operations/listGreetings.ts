// Delegate for `GET /greetings` (operationId `listGreetings`).
//
// The `api` binding in nano.app.json points at `openapi.json`; Urban derives the route,
// the typed request/response contract, and a runtime validator from the spec, then calls
// this delegate. You write only the implementation. The delegate returns `{ status, body }`;
// the runtime serializes `body` as JSON. Docs are served for free at `/app/api-docs`.

import { defineOperation } from "@nanobpm/urban";

interface Greeting {
  id: number;
  who: string;
  message: string;
  createdAt?: string | null;
}

export default defineOperation("listGreetings", (_input, app) => {
  const greetings = app.data.repo("greeting").all<Greeting>();
  return { status: 200, body: { greetings } };
});
