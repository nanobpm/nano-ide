// @ts-check
// ── Shared, XSS-safe form-js schema renderer (ADR 0026, extended by #457) ─────
// This is the ONE client implementation of "render a deployed `.form`'s form-js
// schema and collect its field values", shared verbatim by BOTH:
//   • the `taskInbox` surface (surfaces.ts `inboxPage`), and
//   • the pages `dataGrid` engine-form detail (runtime.browser.js).
// It used to live inline in surfaces.ts; factoring it here means the two surfaces
// can never fork the renderer or drift on how a form-js component maps to an input
// and its submitted value.
//
// Like the rest of the browser runtime it is authored/type-checked/linted/tested
// as real source and served as a generated string artifact (formjs.gen.ts, emitted
// by scripts/gen-runtime.mjs). It performs NO DOM access at load — every DOM touch
// is inside a function — so it is import-safe under Node/Deno for unit testing.
//
// SECURITY: every value the engine returns is placed via textContent / setAttribute
// (never innerHTML), so nothing in the form schema can inject markup. The submitted
// `variables` bag is null-prototype so an engine-supplied component key of
// `__proto__`/`constructor` lands as a plain own property and can never mutate a
// prototype (prototype-pollution class).
//
// VARIABLES CONTEXT (#603): both surfaces pass the task's variables as the render
// `context`. `text` components interpolate `{{name}}` against it (textContent-only,
// never markup), `image` components resolve a `=varName` source from it, and a
// keyed input whose key is present is prefilled — the form-js/Camunda Tasklist
// behaviour, so a reviewer sees what they are reviewing.

/** Create an element, setting attributes via setAttribute and text via textContent only.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {string} [text]
 * @returns {any}
 */
function fjEl(tag, attrs, text) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

/** A plain type="button" with an optional click handler.
 * @param {string} label
 * @param {(() => void) | null} [onClick]
 * @returns {any}
 */
function fjBtn(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** Interpolate `{{name}}` placeholders in a `text` component against the render
 * context (the task's variables), following form-js/Camunda Tasklist. A present
 * value is stringified (objects/arrays as JSON); an unknown name becomes the empty
 * string. The result is placed via textContent only — a variable holding markup
 * (`<img onerror=…>`) renders as literal text, never as HTML (the XSS rule holds
 * for templated text exactly as for static text).
 * @param {string} text
 * @param {Record<string, any>} context
 * @returns {string}
 */
function fjTemplate(text, context) {
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, name) => {
    const v = context[name];
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** Copy only the context's OWN enumerable properties into a null-prototype
 * dictionary, so lookups like `ctx["constructor"]` or `ctx["__proto__"]` never
 * resolve to inherited members (which would template/prefill bogus values), while
 * an explicitly supplied own value with such a name is still honoured.
 * @param {any} context
 * @returns {Record<string, any>}
 */
function fjOwnContext(context) {
  /** @type {Record<string, any>} */
  const out = Object.create(null);
  if (context == null || typeof context !== "object") return out;
  for (const k of Object.keys(context)) {
    Object.defineProperty(out, k, { value: context[k], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Resolve an `image` component's `source` to a URL the renderer will put on the
 * <img>, or null to reject it. `source` is either a literal URL or `=varName` — a
 * PLAIN variable reference into the render context (full FEEL is intentionally not
 * supported: anything after `=` that is not a bare identifier is rejected). Only
 * `http(s):` URLs, app-relative paths (no scheme, no `//host` protocol-relative),
 * and `data:image/(png|jpeg|gif|webp)` URLs are allowed — never `javascript:` or
 * any other scheme. The URL is set with setAttribute (never innerHTML).
 * @param {any} source
 * @param {Record<string, any>} context
 * @returns {string | null}
 */
function fjImageSrc(source, context) {
  let url = source;
  if (typeof url === "string" && url.startsWith("=")) {
    const name = url.slice(1).trim();
    // A plain variable reference only — reject anything that isn't a bare
    // identifier (a FEEL expression, a call, a path) rather than evaluating it.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return null;
    url = context[name];
  }
  if (typeof url !== "string" || url === "") return null;
  // Browsers strip/normalise whitespace and control characters and treat `\` as
  // `/` before interpreting a URL, so `java\tscript:` or ` data:image/svg+xml` or
  // `/\\host` could slip past the allowlist below. Fail closed on any of them.
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  if (/^data:image\/(png|jpeg|gif|webp);/i.test(url)) return url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    // A scheme: only http(s) is allowed (javascript:/data-text-html/etc. rejected).
    return /^https?:\/\//i.test(url) ? url : null;
  }
  if (url.startsWith("//")) return null; // protocol-relative → off-origin, reject
  return url; // app-relative path
}

/** The value a keyed input is prefilled with when its key is present in the render
 * context (form-js prefill semantics): strings as-is, other scalars stringified,
 * objects/arrays as JSON. `undefined`/`null` mean "no prefill".
 * @param {Record<string, any>} context
 * @param {string} key
 * @returns {string | undefined}
 */
function fjPrefill(context, key) {
  const v = context[key];
  if (v == null) return undefined;
  return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Build one form-js component into its field element and (for keyed inputs) a reader
 * that returns the entered `{ key, value }` or null when blank. Static (keyless)
 * components render as inert text; layout-only components are skipped (null).
 * `context` carries the task's variables: `text` components interpolate `{{name}}`
 * against it, `image` components resolve a `=varName` source from it, and a keyed
 * input whose key is present is prefilled with its value.
 * @param {any} c
 * @param {Record<string, any>} [context]
 * @returns {{ field: any, read?: () => ({ key: string, value: any } | null) } | null}
 */
function buildField(c, context) {
  const ctx = fjOwnContext(context);
  const type = c && c.type;
  // Static (keyless) components: show text as a paragraph, ignore layout-only ones.
  if (type === "text") {
    const raw = typeof c.text === "string" ? c.text : "";
    return { field: fjEl("p", { class: "njf-text" }, fjTemplate(raw, ctx)) };
  }
  // An image component (form-js `{ type: "image", source, alt }`) — keyless, renders
  // an <img> whose src is resolved + scheme-gated by fjImageSrc. A rejected/absent
  // source renders nothing (null) rather than a broken or unsafe <img>.
  if (type === "image") {
    const src = fjImageSrc(c.source, ctx);
    if (src == null) return null;
    const attrs = { class: "njf-image", src, alt: typeof c.alt === "string" ? c.alt : "" };
    return { field: fjEl("img", attrs) };
  }
  const key = c && c.key;
  if (!key) return null;
  const wrap = fjEl("div", { class: "njf-field" });
  const label = typeof c.label === "string" && c.label ? c.label : key;
  if (type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    // Prefill: a boolean context value checks the box.
    if (ctx[key] === true) input.checked = true;
    const lab = fjEl("label", {});
    lab.appendChild(input);
    lab.appendChild(document.createTextNode(" " + label));
    wrap.appendChild(lab);
    return { field: wrap, read: () => ({ key, value: input.checked }) };
  }
  const labelEl = fjEl("label", {}, label);
  wrap.appendChild(labelEl);
  let input;
  if (type === "textarea") {
    input = document.createElement("textarea");
    const pre = fjPrefill(ctx, key);
    if (pre !== undefined) input.value = pre;
  } else if (type === "select") {
    input = document.createElement("select");
    input.appendChild(fjEl("option", { value: "" }, "\u2014"));
    const pre = fjPrefill(ctx, key);
    for (const o of Array.isArray(c.values) ? c.values : []) {
      const opt = fjEl("option", { value: String(o.value) }, String(o.label != null ? o.label : o.value));
      // Prefill: mark the option matching the context value as selected.
      if (pre !== undefined && String(o.value) === pre) opt.setAttribute("selected", "");
      input.appendChild(opt);
    }
    if (pre !== undefined) input.value = pre;
  } else if (type === "radio") {
    const name = "r" + Math.random().toString(36).slice(2);
    const pre = fjPrefill(ctx, key);
    const group = fjEl("div", {});
    for (const o of Array.isArray(c.values) ? c.values : []) {
      const rlab = fjEl("label", {});
      const r = document.createElement("input");
      r.type = "radio";
      r.name = name;
      r.value = String(o.value);
      // Prefill: check the option matching the context value.
      if (pre !== undefined && r.value === pre) r.checked = true;
      rlab.appendChild(r);
      rlab.appendChild(document.createTextNode(" " + String(o.label != null ? o.label : o.value)));
      group.appendChild(rlab);
    }
    wrap.appendChild(group);
    return {
      field: wrap,
      read: () => {
        const sel = group.querySelector("input:checked");
        return sel ? { key, value: sel.value } : null;
      },
    };
  } else {
    input = document.createElement("input");
    input.type = type === "number" ? "number" : type === "datetime" ? "datetime-local" : "text";
    const pre = fjPrefill(ctx, key);
    if (pre !== undefined) input.value = pre;
  }
  // Associate the label with the input (for/id) so screen readers announce it on focus.
  const fieldId = "f" + Math.random().toString(36).slice(2);
  input.id = fieldId;
  labelEl.setAttribute("for", fieldId);
  wrap.appendChild(input);
  const isNumber = type === "number";
  return {
    field: wrap,
    read: () => {
      const raw = input.value;
      if (raw === "" || raw == null) return null;
      if (isNumber) {
        const n = Number(raw);
        // A non-numeric value in a number field is only reachable via tampering (the browser
        // blanks invalid type=number input). Treat it as absent rather than silently submitting
        // NaN, which JSON.stringify serializes as null — quietly changing the submitted value.
        return Number.isFinite(n) ? { key, value: n } : null;
      }
      return { key, value: raw };
    },
  };
}

/**
 * Render a form-js schema into a `<form>` element with a submit + optional cancel.
 * On submit it assembles every keyed field's value into one null-prototype
 * `variables` bag and calls `opts.onSubmit(variables)`; a rejected submit re-enables
 * the button so the operator can retry. `opts.onCancel`, when supplied, wires a
 * cancel button. `opts.context` carries the task's variables — `{{name}}` text
 * templating, `=varName` image sources, and keyed-input prefill all resolve
 * against it (see buildField).
 * @param {any} schema the parsed form-js document (`{ components: [...] }`)
 * @param {{ heading?: string, submitLabel?: string, cancelLabel?: string,
 *           context?: Record<string, any>,
 *           onSubmit: (variables: Record<string, any>) => (void | Promise<void>),
 *           onCancel?: () => void }} opts
 * @returns {any} the built <form> element
 */
function renderForm(schema, opts) {
  const form = document.createElement("form");
  form.className = "njf-form";
  if (opts.heading) form.appendChild(fjEl("h2", { class: "njf-heading" }, opts.heading));
  const context = fjOwnContext(opts.context);
  const components = schema && Array.isArray(schema.components) ? schema.components : [];
  /** @type {Array<() => ({ key: string, value: any } | null)>} */
  const inputs = [];
  for (const c of components) {
    const built = buildField(c, context);
    if (!built) continue;
    form.appendChild(built.field);
    if (built.read) inputs.push(built.read);
  }
  const submit = fjBtn(opts.submitLabel || "Submit", null);
  submit.type = "submit";
  const bar = fjEl("div", { class: "njf-actions" });
  bar.appendChild(submit);
  if (opts.onCancel) bar.appendChild(fjBtn(opts.cancelLabel || "Cancel", opts.onCancel));
  form.appendChild(bar);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Null-prototype: field keys come from the engine-supplied form schema. A component
    // keyed '__proto__'/'constructor' must land as a plain own property (and round-trip
    // through JSON), never mutate a prototype — no prototype pollution in the page runtime.
    const variables = Object.create(null);
    for (const read of inputs) {
      const kv = read();
      if (kv) variables[kv.key] = kv.value;
    }
    submit.disabled = true;
    Promise.resolve()
      .then(() => opts.onSubmit(variables))
      .catch(() => {
        submit.disabled = false;
      });
  });
  return form;
}

export { buildField, renderForm };

// Expose the renderer as a browser global so both self-contained page bundles can
// reach the ONE implementation without importing it: the taskInbox page embeds this
// module inline and the pages shell does the same before loading the ES-module
// runtime, which reads `globalThis.NanoFormJs` lazily when it renders an engine form.
// Guarded so importing under Node/Deno for tests is a harmless no-op-ish assignment.
if (typeof globalThis !== "undefined") {
  /** @type {any} */ (globalThis).NanoFormJs = { buildField, renderForm };
}
