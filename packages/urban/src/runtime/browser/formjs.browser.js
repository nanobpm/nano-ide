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

/** The image-source allowlist, applied to BOTH the raw source and — when a
 * `resolveUrl` rewrote it — the RESOLVED URL. A resolver is same-origin trusted
 * code, but it TRANSFORMS the string (the pages runtime's `apiUrl` strips the
 * leading slash before `new URL(...)`), and a transformation can mint a forbidden
 * shape from an accepted one: a root-prefixed script-scheme path passes below as
 * an app-relative path (the leading slash defeats the scheme check), then
 * resolves to the bare forbidden-scheme URL. Re-running the allowlist on the
 * resolver's result closes that laundering class at the single choke point every
 * surface flows through, so no resolver — present or future — can widen the
 * accepted set.
 * @param {string} url
 * @returns {string | null} the URL when allowed, null when rejected
 */
function fjAllowImageUrl(url) {
  // Browsers strip/normalise whitespace and control characters and treat `\` as
  // `/` before interpreting a URL, so `java\tscript:` or ` data:image/svg+xml` or
  // `/\\host` could slip past the allowlist below. Fail closed on any of them.
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  // data:image — RFC 2397 lets the mediatype be followed directly by `,`
  // (parameters and `;base64` are both optional), so accept `;` OR `,` after the
  // subtype or a percent-encoded payload silently never renders.
  if (/^data:image\/(png|jpeg|gif|webp)[;,]/i.test(url)) return url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    // A scheme: only http(s) is allowed (javascript:/data-text-html/etc. rejected).
    return /^https?:\/\//i.test(url) ? url : null;
  }
  if (url.startsWith("//")) return null; // protocol-relative → off-origin, reject
  return url; // app-relative path
}

/** Resolve an `image` component's `source` to a URL the renderer will put on the
 * <img>, or null to reject it. `source` is either a literal URL or `=varName` — a
 * PLAIN variable reference into the render context (full FEEL is intentionally not
 * supported: anything after `=` that is not a bare identifier is rejected). Only
 * `http(s):` URLs, app-relative paths (no scheme, no `//host` protocol-relative),
 * and `data:image/(png|jpeg|gif|webp)` URLs are allowed — never `javascript:` or
 * any other scheme. The URL is set with setAttribute (never innerHTML).
 * `resolveUrl`, when supplied, rewrites an ACCEPTED URL just before it is set —
 * both surfaces pass their app-mount-aware resolver (the pages runtime's `apiUrl`,
 * the inbox page's mount prefix) so a root-relative `/app/…` source requests the
 * app's own path even behind the console's path-prefixed proxy. The allowlist runs
 * on the raw source AND again on the resolver's result (see fjAllowImageUrl), so a
 * resolver can never launder a rejected URL — including one it minted itself by
 * rebasing a disguised path.
 * @param {any} source
 * @param {Record<string, any>} context
 * @param {(url: string) => string} [resolveUrl]
 * @returns {string | null}
 */
function fjImageSrc(source, context, resolveUrl) {
  let url = source;
  if (typeof url === "string" && url.startsWith("=")) {
    const name = url.slice(1).trim();
    // A plain variable reference only — reject anything that isn't a bare
    // identifier (a FEEL expression, a call, a path) rather than evaluating it.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return null;
    url = context[name];
  }
  if (typeof url !== "string" || url === "") return null;
  const allowed = fjAllowImageUrl(url);
  if (allowed == null) return null;
  // App-relative path. A root-relative one ("/app/…") is only correct when the app
  // is served at the origin root; behind the console's path-prefixed proxy it must
  // be rebased onto the app mount (the resolver both surfaces pass). Absolute
  // http(s)/data: URLs pass through untouched (the resolvers only rewrite
  // single-leading-slash paths), but revalidate the result regardless — a resolver
  // that strips the leading slash (the pages `apiUrl`) turns "/javascript:…" into
  // a forbidden-scheme URL, which must not reach the <img>.
  if (!resolveUrl) return allowed;
  const resolved = resolveUrl(allowed);
  if (typeof resolved !== "string" || resolved === "") return null;
  // Re-run the SAME allowlist on the resolver's output (one source of truth):
  // app-relative paths, http(s) and data:image survive; a forbidden scheme the
  // resolver minted (e.g. "/javascript:…" stripped to "javascript:…"), a file:
  // URL, or a protocol-relative URL is rejected.
  return fjAllowImageUrl(resolved);
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
 * @param {{ resolveUrl?: (url: string) => string }} [opts]
 * @returns {{ field: any, read?: () => ({ key: string, value: any } | null) } | null}
 */
function buildField(c, context, opts) {
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
    const src = fjImageSrc(c.source, ctx, opts && opts.resolveUrl);
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
  // Was this field prefilled from the context — AND did the control ACCEPT the
  // value? Only a successful prefill counts: a prefilled field the operator CLEARS
  // (empties the text input, picks the blank select option) must submit an empty
  // string — returning null would omit the key and silently leave the original
  // variable unchanged. But a REJECTED prefill (a select value matching no option,
  // a timezone-bearing timestamp a datetime-local control blanks) leaves the
  // control empty through no operator action; treating that as prefilled would
  // submit "" from an untouched form and overwrite the original variable. A
  // rejected prefill behaves like no prefill: blank means "not entered", so the
  // key is omitted.
  let prefilled = false;
  if (type === "textarea") {
    input = document.createElement("textarea");
    const pre = fjPrefill(ctx, key);
    if (pre !== undefined) {
      input.value = pre;
      prefilled = true;
    }
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
    if (pre !== undefined) {
      input.value = pre;
      // The select ACCEPTS the prefill only when it matches a declared option —
      // otherwise the DOM snaps the value back to "" and the control sits blank.
      // Check acceptance structurally (against the option list), not by reading
      // the value back: the control must not be treated as prefilled when it
      // could not take the value, or an untouched submit would overwrite the
      // original variable with "".
      const accepted = (Array.isArray(c.values) ? c.values : []).some((/** @type {any} */ o) => String(o.value) === pre);
      prefilled = pre !== "" && accepted;
    }
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
    if (pre !== undefined) {
      input.value = pre;
      // A typed control (number/datetime-local) sanitizes a value it cannot hold
      // to "" — e.g. a timezone-bearing timestamp assigned to datetime-local. Only
      // a value that survived counts as a successful prefill.
      prefilled = input.value !== "";
    }
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
      // A prefilled field the operator cleared submits an empty string (an explicit
      // "set this variable to empty"), never an omission that would leave the
      // original value in place. A never-prefilled blank field is still omitted.
      if (raw === "" || raw == null) return prefilled ? { key, value: "" } : null;
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
 * against it (see buildField). `opts.resolveUrl`, when supplied, rewrites each
 * ACCEPTED image source before it is set — both surfaces pass their app-mount-aware
 * resolver so a root-relative `/app/…` image survives the console's path-prefixed
 * proxy (see fjImageSrc).
 * @param {any} schema the parsed form-js document (`{ components: [...] }`)
 * @param {{ heading?: string, submitLabel?: string, cancelLabel?: string,
 *           context?: Record<string, any>,
 *           resolveUrl?: (url: string) => string,
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
    const built = buildField(c, context, { resolveUrl: opts.resolveUrl });
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
