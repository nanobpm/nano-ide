// surfaces — the hosted human surfaces (ADR 0026). Implements the `taskInbox` surface: a
// small JSON+HTML task list backed by the engine's user-task search, that renders the
// linked `.form` and posts completion back. The `chat` surface is stubbed as a mount point
// (LLM wiring is a separate concern). Surfaces contribute routes to the shared server.

import type { AppApi, RuntimeContext } from "../context.ts";
import { html, json, normalizeRoutePath, type Route } from "../router.ts";
import { mountActions } from "./actions.ts";
import { mountApi } from "./api.ts";
import { mountPages } from "./pages.ts";

/** Escape HTML-significant characters before embedding a value in markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface SurfacesHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

function inboxPage(basePath: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Task inbox</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;max-width:52rem}
li{margin:.4rem 0}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}</style>
<h1>Task inbox</h1><ul id="tasks"><li>loading…</li></ul>
<script>
fetch(${JSON.stringify(basePath)}+'/api/tasks').then(r=>r.json()).then(ts=>{
  const ul=document.getElementById('tasks');
  ul.replaceChildren();
  if(!ts.length){const li=document.createElement('li');li.textContent='No open tasks.';ul.appendChild(li);return;}
  for(const t of ts){const li=document.createElement('li');
    const code=document.createElement('code');
    code.textContent=t.elementId||t.userTaskKey;
    li.appendChild(code);
    li.appendChild(document.createTextNode(' — key '+t.userTaskKey));
    ul.appendChild(li);}
});
</script>`;
}

/** Mount the enabled surfaces and return their routes. */
export function mountSurfaces(ctx: RuntimeContext, app: AppApi): SurfacesHandle {
  const routes: Route[] = [];
  const surfaces = ctx.manifest.surfaces ?? {};
  const enabled: string[] = [];

  const inbox = surfaces.taskInbox;
  if (inbox?.enabled) {
    const base = normalizeRoutePath(inbox.path, "/tasks");
    enabled.push(`taskInbox@${base}`);
    routes.push({
      method: "GET",
      path: base,
      source: "surface:taskInbox",
      handler: () => html(inboxPage(base)),
    });
    routes.push({
      method: "GET",
      path: `${base}/api/tasks`,
      source: "surface:taskInbox",
      handler: async (req) => {
        const pik = req.query.get("processInstanceKey") ?? undefined;
        const tasks = await app.engine.searchUserTasks(pik ? { processInstanceKey: pik } : undefined);
        return json(tasks);
      },
    });
    routes.push({
      method: "POST",
      path: `${base}/api/complete`,
      source: "surface:taskInbox",
      handler: async (req) => {
        let body: { userTaskKey?: string; variables?: Record<string, unknown> };
        try {
          body = JSON.parse((await req.text()) || "{}");
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
        if (!body.userTaskKey) return json({ error: "userTaskKey required" }, 400);
        await app.engine.completeUserTask(body.userTaskKey, body.variables);
        return json({ ok: true });
      },
    });
  }

  const chat = surfaces.chat;
  if (chat?.enabled) {
    const base = normalizeRoutePath(chat.path, "/chat");
    enabled.push(`chat@${base}`);
    routes.push({
      method: "GET",
      path: base,
      source: "surface:chat",
      handler: () =>
        html(`<!doctype html><meta charset="utf-8"><title>Chat</title>
<body style="font:14px system-ui;margin:2rem"><h1>Chat</h1>
<p>Chat surface mount point (agent: <code>${escapeHtml(chat.agent ?? "?")}</code>). LLM wiring pending.</p>`),
    });
  }

  // App-authored action overrides mount BEFORE the generic pages routes so an exact
  // override (e.g. /app/actions/cancel) shadows the generic action; the router is
  // first-match-wins.
  const actions = mountActions(ctx, app);
  if (actions.routes.length > 0) {
    routes.push(...actions.routes);
    enabled.push(`actions(${actions.routes.length})`);
  }

  // The OpenAPI endpoint surface (ADR 0058) mounts AFTER actions (so an exact `actions[]` route
  // still shadows an operation) and BEFORE the generic pages routes. It owns the fixed `/app/api`
  // namespace via a regex dispatcher, so it only contributes routes when the app declares `api`.
  const api = mountApi(ctx, app);
  if (api.routes.length > 0) {
    routes.push(...api.routes);
    enabled.push("api");
  }

  // The pages surface (the schema-driven page runtime) mounts its own routes.
  const pages = mountPages(ctx, app);
  if (pages.routes.length > 0) {
    routes.push(...pages.routes);
    enabled.push("pages@/");
  }

  ctx.host.log("info", "surfaces mounted", { enabled });
  return { name: "surfaces", routes, describe: () => ({ enabled }) };
}
