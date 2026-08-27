// surfaces — the hosted human surfaces (ADR 0026). Implements the `taskInbox` surface: a
// small JSON+HTML task list backed by the engine's user-task search. Each open task links to
// its deployed `.form` via the engine-resolved `formKey`; the list fetches that form's form-js
// schema (`GET base/api/form`), renders its fields client-side with a minimal built-in
// renderer, and posts the entered field values as the completion `variables` (`POST
// base/api/complete`). A task with no linked form keeps the bare key-list + raw-complete
// behavior. The `chat` surface is stubbed as a mount point (LLM wiring is a separate concern).
// Surfaces contribute routes to the shared server.

import type { AppApi, RuntimeContext } from "../context.ts";
import { html, json, normalizeRoutePath, type Route } from "../router.ts";
import { FORMJS_JS } from "./formjs.gen.ts";
import { completeUserTaskResponse, resolveFormResponse } from "./forms.ts";
import { mountActions } from "./actions.ts";
import { mountAgent } from "./agent.ts";
import { mountApi } from "./api.ts";
import { mountMcp } from "./mcp.ts";
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

function inboxPage(): string {
  // Reverse-proxy safe: the client derives its API base from location.pathname
  // (where THIS page was actually served) rather than an embedded absolute
  // route base. A hardcoded "/tasks" would escape the Nano console's
  // path-prefixed proxy (/console/app-view/<name>/tasks) — the API fetches must
  // inherit that prefix. Deriving from location also removes the manifest→
  // <script> injection surface entirely: nothing manifest-supplied is embedded.
  // All task/form values are rendered via textContent / setAttribute — never
  // innerHTML — so nothing the engine returns can inject markup.
  return `<!doctype html><meta charset="utf-8"><title>Task inbox</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;max-width:52rem}
ul{list-style:none;padding:0}li{margin:.4rem 0;display:flex;align-items:center;gap:.5rem}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}
button{font:inherit;padding:.2rem .6rem;cursor:pointer}
.njf-field label{display:block;margin:.6rem 0 .2rem;font-weight:600}
.njf-field input,.njf-field textarea,.njf-field select{font:inherit;padding:.3rem;width:100%;box-sizing:border-box;max-width:24rem}
.njf-field input[type=checkbox],.njf-field input[type=radio]{width:auto}
.njf-actions{margin-top:.6rem}
#form{margin-top:1.5rem;border-top:1px solid #ddd;padding-top:1rem}
.muted{color:#666}</style>
<h1>Task inbox</h1><ul id="tasks"><li>loading…</li></ul>
<div id="form"></div>
<script>${FORMJS_JS}</script>
<script>
const BASE=location.pathname.replace(/[/]+$/,'');
const tasksEl=document.getElementById('tasks');
const formEl=document.getElementById('form');

function api(path,opts){return fetch(BASE+path,opts).then(r=>{if(!r.ok)return r.text().then(t=>{throw new Error(t||r.status)});if(r.status===204)return null;return r.json();});}

function loadTasks(){
  formEl.replaceChildren();
  tasksEl.replaceChildren(el('li',{},'loading…'));
  return api('/api/tasks'+location.search).then(ts=>{
    tasksEl.replaceChildren();
    if(!ts.length){tasksEl.appendChild(el('li',{},'No open tasks.'));return;}
    for(const t of ts){
      const li=document.createElement('li');
      const code=el('code',{},t.elementId||t.userTaskKey);
      li.appendChild(code);
      li.appendChild(document.createTextNode(' — key '+t.userTaskKey));
      if(t.formKey){
        li.appendChild(btn('Open',()=>openForm(t)));
      }else{
        li.appendChild(btn('Complete',()=>complete(t.userTaskKey,{})));
      }
      tasksEl.appendChild(li);
    }
  }).catch(err=>tasksEl.replaceChildren(el('li',{class:'muted'},'Failed to load tasks: '+err.message)));
}

function openForm(t){
  formEl.replaceChildren(el('p',{class:'muted'},'loading form…'));
  const q='formKey='+encodeURIComponent(t.formKey);
  api('/api/form?'+q).then(f=>{
    formEl.replaceChildren();
    if(!f||!f.schema){renderNoForm(t);return;}
    // Reuse the ONE shared form-js renderer (NanoFormJs) — no fork with the pages surface.
    formEl.appendChild(NanoFormJs.renderForm(f.schema,{
      heading:'Task '+(t.elementId||t.userTaskKey),
      submitLabel:'Submit',
      cancelLabel:'Cancel',
      onSubmit:(variables)=>complete(t.userTaskKey,variables),
      onCancel:loadTasks,
    }));
  }).catch(err=>{formEl.replaceChildren(el('p',{class:'muted'},'Failed to load form: '+err.message));});
}

function renderNoForm(t){
  formEl.appendChild(el('p',{class:'muted'},'This task has no renderable form.'));
  const bar=el('div',{});
  bar.appendChild(btn('Complete',()=>complete(t.userTaskKey,{})));
  bar.appendChild(btn('Cancel',loadTasks));
  formEl.appendChild(bar);
}

function complete(userTaskKey,variables){
  return api('/api/complete',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({userTaskKey,variables})}).then(loadTasks);
}

function el(tag,attrs,text){const e=document.createElement(tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;}
function btn(label,onClick){const b=document.createElement('button');b.type='button';b.textContent=label;if(onClick)b.addEventListener('click',onClick);return b;}

loadTasks();
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
      handler: () => html(inboxPage()),
    });
    routes.push({
      method: "GET",
      path: `${base}/api/tasks`,
      source: "surface:taskInbox",
      handler: async (req) => {
        const pik = req.query.get("processInstanceKey") ?? undefined;
        const assignee = req.query.get("assignee") ?? undefined;
        const candidateGroup = req.query.get("candidateGroup") ?? undefined;
        // Constrain the inbox to open (answerable) tasks via openUserTasks — the accessor that
        // pins state="CREATED" for us. A bare searchUserTasks returns tasks in every state
        // (CREATED/COMPLETED/CANCELED/...), so already-answered or withdrawn tasks would surface
        // as if actionable — completing one then fails with "User task ... is not active".
        // Deriving the pin from openUserTasks (rather than re-pinning state here) keeps the
        // definition of "open" single-sourced. See nanobpm/nano-ide#248.
        const tasks = await app.engine.openUserTasks({
          ...(pik ? { processInstanceKey: pik } : {}),
          ...(assignee ? { assignee } : {}),
          ...(candidateGroup ? { candidateGroup } : {}),
        });
        return json(tasks);
      },
    });
    routes.push({
      method: "GET",
      path: `${base}/api/form`,
      source: "surface:taskInbox",
      handler: async (req) =>
        resolveFormResponse(app.engine, req.query.get("formKey") ?? undefined, req.query.get("formId") ?? undefined),
    });
    routes.push({
      method: "POST",
      path: `${base}/api/complete`,
      source: "surface:taskInbox",
      handler: async (req) => completeUserTaskResponse(app.engine, await req.text()),
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

  // The app-scoped institutional-memory brief (ADR 0060 §2): `/app/agent` + `/app/agent.json`,
  // the app-level mirror of the node `/agent`. Mounted unconditionally (before the generic pages
  // routes, though its exact paths never collide) — the brief is a property of the app's models,
  // not an opt-in surface, and reads through to the `urban gen`-derived artifacts.
  const agent = mountAgent(ctx);
  routes.push(...agent.routes);
  enabled.push("agent@/app/agent");

  // The runtime-served MCP surface (ADR 0067): `/app/mcp`, a Streamable-HTTP MCP endpoint mounted
  // unconditionally (like `/app/agent`) so an MCP client always has a stable address. It projects
  // the app's read-only OpenAPI operations as tools from the SAME enumeration `mountApi` routes
  // from, plus framework-owned read-only process-debugging tools — zero app-side MCP code.
  const mcp = mountMcp(ctx, app);
  routes.push(...mcp.routes);
  enabled.push("mcp@/app/mcp");

  // The pages surface (the schema-driven page runtime) mounts its own routes.
  const pages = mountPages(ctx, app);
  if (pages.routes.length > 0) {
    routes.push(...pages.routes);
    enabled.push("pages@/");
  }

  ctx.host.log("info", "surfaces mounted", { enabled });
  return { name: "surfaces", routes, describe: () => ({ enabled }) };
}
