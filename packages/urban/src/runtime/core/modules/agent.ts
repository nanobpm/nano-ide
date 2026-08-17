// agent — the app-scoped institutional-memory brief surface (ADR 0060 §2). The app-level mirror
// of the node `/agent` brief (ADR 0051): where the node brief describes the whole runtime, this
// serves ONE app's derived `system-brief.md` / `system-brief.json` so an agent (or human) opening
// work on the app starts grounded in the app's own system model — its processes, service-task call
// graph, decisions, and ownership.
//
//   GET /app/agent       → nano-generated/system-brief.md   (text/markdown)
//   GET /app/agent.json  → nano-generated/system-brief.json (application/json)
//
// The brief is derived by `urban gen` (systemBriefDeriver, wired in gen.ts) into the app's
// `nano-generated/` dir, so this route is a thin read-through of that artifact — no re-derivation
// at request time (the derived file is the single source of truth, kept honest by
// `urban gen --check`). Mounted unconditionally: the brief is a property of the app's models, not
// of any opt-in surface, so it is always addressable when a brief has been generated. An app whose
// models produced no brief (never ran gen) returns 404.

import { GENERATED_DIR } from "../../../toolkit/artifact.ts";
import { SYSTEM_BRIEF_JSON, SYSTEM_BRIEF_MD } from "../../../toolkit/derivers/system-brief.ts";
import type { RuntimeContext } from "../context.ts";
import type { HttpResponse } from "../host.ts";
import { json, type Route } from "../router.ts";
import { resolveAppPath } from "./datasource.ts";

/** The app-relative path of a generated brief artifact. */
const briefPath = (name: string): string => `${GENERATED_DIR}/${name}`;

export interface AgentHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

function markdown(body: string): HttpResponse {
  return { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" }, body };
}

/**
 * Mount the `/app/agent` (+ `/app/agent.json`) institutional-memory brief routes. Reads the
 * `urban gen`-derived artifacts through the host file port, resolving each under `ctx.root` via
 * the shared `resolveAppPath` (like every other runtime module) so serving never depends on the
 * host's current working directory. A genuinely absent artifact — checked with `host.exists`
 * rather than a blanket catch — yields a 404 (gen never ran, or the app has no models); any other
 * read failure (permissions, transient I/O) is left to surface as a 500 rather than being masked
 * as "not generated".
 */
export function mountAgent(ctx: RuntimeContext): AgentHandle {
  const artifactPath = (name: string): string => resolveAppPath(ctx.root, briefPath(name));
  const notGenerated = (): HttpResponse =>
    json({ error: "system brief not generated — run `urban gen`" }, 404);
  const serve = async (name: string, toResponse: (body: string) => HttpResponse): Promise<HttpResponse> => {
    const path = artifactPath(name);
    if (!(await ctx.host.exists(path))) return notGenerated();
    return toResponse(await ctx.host.readTextFile(path));
  };
  const routes: Route[] = [
    {
      method: "GET",
      path: "/app/agent",
      source: "surface:agent",
      handler: () => serve(SYSTEM_BRIEF_MD, markdown),
    },
    {
      method: "GET",
      path: "/app/agent.json",
      source: "surface:agent",
      handler: () =>
        serve(SYSTEM_BRIEF_JSON, (body) => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body,
        })),
    },
  ];
  ctx.host.log("info", "agent brief surface mounted", { routes: routes.length });
  return { name: "agent", routes, describe: () => ({ routes: routes.map((r) => r.path) }) };
}
