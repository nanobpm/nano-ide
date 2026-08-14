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
  // The base path is embedded as a JSON string literal so a manifest-supplied value
  // cannot break out of the <script> (see surfaces.test.ts). All task/form values are
  // rendered via textContent / setAttribute — never innerHTML — so nothing the engine
  // returns can inject markup.
  return `<!doctype html><meta charset="utf-8"><title>Task inbox</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;max-width:52rem}
ul{list-style:none;padding:0}li{margin:.4rem 0;display:flex;align-items:center;gap:.5rem}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}
button{font:inherit;padding:.2rem .6rem;cursor:pointer}
form label{display:block;margin:.6rem 0 .2rem;font-weight:600}
form .field input,form .field textarea,form .field select{font:inherit;padding:.3rem;width:100%;box-sizing:border-box;max-width:24rem}
form .field input[type=checkbox],form .field input[type=radio]{width:auto}
#form{margin-top:1.5rem;border-top:1px solid #ddd;padding-top:1rem}
.muted{color:#666}</style>
<h1>Task inbox</h1><ul id="tasks"><li>loading…</li></ul>
<div id="form"></div>
<script>
const BASE=${JSON.stringify(basePath)};
const tasksEl=document.getElementById('tasks');
const formEl=document.getElementById('form');

function api(path,opts){return fetch(BASE+path,opts).then(r=>r.ok?r.json():r.text().then(t=>{throw new Error(t||r.status)}));}

function loadTasks(){
  formEl.replaceChildren();
  tasksEl.replaceChildren(el('li',{},'loading…'));
  return api('/api/tasks').then(ts=>{
    tasksEl.replaceChildren();
    if(!ts.length){tasksEl.appendChild(el('li',{},'No open tasks.'));return;}
    for(const t of ts){
      const li=document.createElement('li');
      const code=el('code',{},t.elementId||t.userTaskKey);
      li.appendChild(code);
      li.appendChild(document.createTextNode(' — key '+t.userTaskKey));
      if(t.formKey||t.formId){
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
  const q=t.formKey?('formKey='+encodeURIComponent(t.formKey)):('formId='+encodeURIComponent(t.formId));
  api('/api/form?'+q).then(f=>{
    formEl.replaceChildren();
    if(!f||!f.schema){renderNoForm(t);return;}
    renderForm(t,f.schema);
  }).catch(err=>{formEl.replaceChildren(el('p',{class:'muted'},'Failed to load form: '+err.message));});
}

function renderNoForm(t){
  formEl.appendChild(el('p',{class:'muted'},'This task has no renderable form.'));
  const bar=el('div',{});
  bar.appendChild(btn('Complete',()=>complete(t.userTaskKey,{})));
  bar.appendChild(btn('Cancel',loadTasks));
  formEl.appendChild(bar);
}

function renderForm(t,schema){
  const form=document.createElement('form');
  form.appendChild(el('h2',{},'Task '+(t.elementId||t.userTaskKey)));
  const components=Array.isArray(schema.components)?schema.components:[];
  const inputs=[];
  for(const c of components){
    const built=buildField(c);
    if(!built)continue;
    form.appendChild(built.field);
    if(built.read)inputs.push(built.read);
  }
  const submit=btn('Submit',null);submit.type='submit';
  const bar=el('div',{});bar.appendChild(submit);bar.appendChild(btn('Cancel',loadTasks));
  form.appendChild(bar);
  form.addEventListener('submit',e=>{
    e.preventDefault();
    const variables={};
    for(const read of inputs){const kv=read();if(kv)variables[kv.key]=kv.value;}
    submit.disabled=true;
    complete(t.userTaskKey,variables).catch(()=>{submit.disabled=false;});
  });
  formEl.appendChild(form);
}

function buildField(c){
  const type=c&&c.type;
  // Static (keyless) components: show text as a paragraph, ignore layout-only ones.
  if(type==='text'){return {field:el('p',{class:'muted'},typeof c.text==='string'?c.text:'')};}
  const key=c&&c.key;
  if(!key)return null;
  const wrap=el('div',{class:'field'});
  const label=typeof c.label==='string'&&c.label?c.label:key;
  if(type==='checkbox'){
    const input=document.createElement('input');input.type='checkbox';
    const lab=el('label',{});lab.appendChild(input);lab.appendChild(document.createTextNode(' '+label));
    wrap.appendChild(lab);
    return {field:wrap,read:()=>({key,value:input.checked})};
  }
  wrap.appendChild(el('label',{},label));
  let input;
  if(type==='textarea'){input=document.createElement('textarea');}
  else if(type==='select'){
    input=document.createElement('select');
    input.appendChild(el('option',{value:''},'—'));
    for(const o of (Array.isArray(c.values)?c.values:[])){
      input.appendChild(el('option',{value:String(o.value)},String(o.label!=null?o.label:o.value)));
    }
  }
  else if(type==='radio'){
    const name='r'+Math.random().toString(36).slice(2);
    const group=el('div',{});
    for(const o of (Array.isArray(c.values)?c.values:[])){
      const rlab=el('label',{});
      const r=document.createElement('input');r.type='radio';r.name=name;r.value=String(o.value);
      rlab.appendChild(r);rlab.appendChild(document.createTextNode(' '+String(o.label!=null?o.label:o.value)));
      group.appendChild(rlab);
    }
    wrap.appendChild(group);
    return {field:wrap,read:()=>{const sel=group.querySelector('input:checked');return sel?{key,value:sel.value}:null;}};
  }
  else{
    input=document.createElement('input');
    input.type=(type==='number')?'number':(type==='datetime'?'datetime-local':'text');
  }
  wrap.appendChild(input);
  const isNumber=type==='number';
  return {field:wrap,read:()=>{
    const raw=input.value;
    if(raw===''||raw==null)return null;
    return {key,value:isNumber?Number(raw):raw};
  }};
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
      method: "GET",
      path: `${base}/api/form`,
      source: "surface:taskInbox",
      handler: async (req) => {
        const formKey = req.query.get("formKey") ?? undefined;
        const formId = req.query.get("formId") ?? undefined;
        if (!formKey && !formId) return json({ error: "formKey or formId required" }, 400);
        const form = await app.engine.getForm({ formKey, formId });
        // A task whose form can't be resolved returns 204: the client renders the
        // no-form fallback rather than erroring.
        if (!form) return json(null, 204);
        return json(form);
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
