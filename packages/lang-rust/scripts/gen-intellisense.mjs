#!/usr/bin/env node
// Derive the Rust IntelliSense block of nano-ide.ext.json from the Camunda Rust
// SDK's own rustdoc. We do NOT hand-author completions, signatures, or docs —
// the SDK is strongly typed and self-documenting, so this generator asks rustdoc
// to emit its JSON doc model for the two published crates the pack builds
// against (the `camunda-orchestration-sdk` facade + its
// `camunda-orchestration-api-client` models crate) and derives the manifest's
// `intellisense` array from it.
//
// The console's pack-fed completion provider is a flat, global list (there is no
// in-browser rust-analyzer to scope member completions to a receiver type), so
// we derive only the client *entry-point* surface — the handful of types a
// worker/app author actually types (CamundaClient + the create-instance models)
// — keeping the suggestions relevant. All the text (doc comments, parameter
// types, signatures) is derived, never duplicated.
//
// Usage:  node scripts/gen-intellisense.mjs [--check]
//   --check  exit non-zero if the manifest is out of date (for CI), no write.
//
// The SDK version constraint is read from the starter template's Cargo.toml.
// rustdoc JSON is a nightly-only format; override the toolchain with
// NANO_RUSTDOC_TOOLCHAIN (default: the pinned PINNED_NIGHTLY below — rustdoc
// JSON output drifts between nightlies, so a floating "nightly" is not
// deterministic; CI installs exactly this toolchain). Pre-generated JSON can be supplied
// via NANO_RUSTDOC_DIR (dir containing the two *.json files) to skip the build.

import { execFileSync } from "node:child_process";

export const PINNED_NIGHTLY = "nightly-2026-06-26";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(HERE, "..");
const MANIFEST = join(PACK_ROOT, "nano-ide.ext.json");
const TEMPLATE_DIR = join(PACK_ROOT, "templates", "rust-starter");
const TEMPLATE_CARGO = join(TEMPLATE_DIR, "Cargo.toml");

const FACADE_CRATE = "camunda-orchestration-sdk";
const CLIENT_CRATE = "camunda-orchestration-api-client";
const FACADE_JSON = "camunda_orchestration_sdk.json";
const CLIENT_JSON = "camunda_orchestration_api_client.json";

// Entry-point types a worker/app author types directly. Members of these are
// surfaced as global completions; every other SDK type stays out of the flat
// list (it would only add noise without type-scoped completion).
const FACADE_TYPES = new Set([
  "CamundaClient",
  "CamundaClientBuilder",
  "JobWorker",
  "JobWorkerBuilder",
  "JobWorkerConfig",
  "ActivatedJob",
]);
const CLIENT_TYPES = new Set([
  "ProcessInstanceCreationInstruction",
  "ProcessInstanceCreationInstructionById",
  "ProcessInstanceCreationInstructionByKey",
  "CreateProcessInstanceResult",
  "ProcessDefinitionId",
  "ProcessDefinitionKey",
]);

function fail(msg) {
  console.error(`gen-intellisense: ${msg}`);
  process.exit(1);
}

function sdkVersion() {
  const toml = readFileSync(TEMPLATE_CARGO, "utf8");
  const m = toml.match(/camunda-orchestration-sdk\s*=\s*"([^"]+)"/);
  return m ? m[1] : "unknown";
}

// --- rustdoc JSON acquisition ----------------------------------------------

function runRustdoc(crate, targetDir) {
  const toolchain = process.env.NANO_RUSTDOC_TOOLCHAIN || PINNED_NIGHTLY;
  execFileSync(
    "cargo",
    [
      `+${toolchain}`,
      "rustdoc",
      "--locked",
      "-p",
      crate,
      "--",
      "-Z",
      "unstable-options",
      "--output-format",
      "json",
    ],
    {
      cwd: TEMPLATE_DIR,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, RUSTC_BOOTSTRAP: "1", CARGO_TARGET_DIR: targetDir },
    },
  );
}

function acquireDocs() {
  const preDir = process.env.NANO_RUSTDOC_DIR;
  if (preDir) {
    return {
      facade: JSON.parse(readFileSync(join(preDir, FACADE_JSON), "utf8")),
      client: JSON.parse(readFileSync(join(preDir, CLIENT_JSON), "utf8")),
      cleanup: () => {},
    };
  }
  // Reuse a caller-provided CARGO_TARGET_DIR (e.g. a CI cache) when set — and
  // leave it in place; otherwise build into a throwaway temp dir we clean up.
  const external = process.env.CARGO_TARGET_DIR;
  const target = external || mkdtempSync(join(tmpdir(), "nano-rustdoc-"));
  try {
    runRustdoc(FACADE_CRATE, target);
    runRustdoc(CLIENT_CRATE, target);
  } catch (e) {
    fail(
      `rustdoc failed (need a nightly toolchain; set NANO_RUSTDOC_TOOLCHAIN or ` +
        `pre-generate JSON via NANO_RUSTDOC_DIR): ${e.message}`,
    );
  }
  const facadePath = join(target, "doc", FACADE_JSON);
  const clientPath = join(target, "doc", CLIENT_JSON);
  if (!existsSync(facadePath) || !existsSync(clientPath)) {
    fail("rustdoc did not produce the expected JSON files");
  }
  return {
    facade: JSON.parse(readFileSync(facadePath, "utf8")),
    client: JSON.parse(readFileSync(clientPath, "utf8")),
    cleanup: () =>
      external ? undefined : rmSync(target, { recursive: true, force: true }),
  };
}

// --- rustdoc type rendering -------------------------------------------------

function lastSeg(path) {
  const s = String(path);
  const i = s.lastIndexOf("::");
  return i >= 0 ? s.slice(i + 2) : s;
}

function renderType(t) {
  if (t == null) return "()";
  if (typeof t === "string") return t;
  if ("primitive" in t) return t.primitive;
  if ("generic" in t) return t.generic;
  if ("resolved_path" in t) {
    const rp = t.resolved_path;
    let name = lastSeg(rp.path);
    const args =
      rp.args && rp.args.angle_bracketed && rp.args.angle_bracketed.args;
    if (args && args.length) {
      const inner = args
        .map((a) => (a && a.type ? renderType(a.type) : null))
        .filter(Boolean)
        .join(", ");
      if (inner) name += `<${inner}>`;
    }
    return name;
  }
  if ("borrowed_ref" in t) {
    const br = t.borrowed_ref;
    return `&${br.is_mutable ? "mut " : ""}${renderType(br.type)}`;
  }
  if ("tuple" in t) return `(${t.tuple.map(renderType).join(", ")})`;
  if ("slice" in t) return `[${renderType(t.slice)}]`;
  if ("array" in t) return `[${renderType(t.array.type)}; ${t.array.len}]`;
  if ("raw_pointer" in t) return `*${renderType(t.raw_pointer.type)}`;
  if ("dyn_trait" in t) {
    const tr = t.dyn_trait.traits?.[0]?.trait;
    return `dyn ${tr ? lastSeg(tr.path) : "?"}`;
  }
  if ("impl_trait" in t) return "impl Trait";
  if ("qualified_path" in t) return t.qualified_path.name;
  return "_";
}

// --- derivation -------------------------------------------------------------

function idGet(idx, id) {
  return idx[String(id)] ?? idx[id];
}

// Collect the entry-type surface within one crate's rustdoc index.
function collectSurface(doc, entryTypes) {
  const idx = doc.index;
  const types = [];
  const methods = [];
  const fields = [];
  const variants = [];

  const entryIdToName = new Map();
  for (const it of Object.values(idx)) {
    const inner = it.inner || {};
    if (("struct" in inner || "enum" in inner) && entryTypes.has(it.name)) {
      entryIdToName.set(it.id, it.name);
      types.push({ name: it.name, docs: it.docs || "" });
      if ("struct" in inner) {
        const k = inner.struct.kind;
        const fids = k && k.plain ? k.plain.fields : [];
        for (const fid of fids || []) {
          const f = idGet(idx, fid);
          if (f && f.name)
            fields.push({ typeName: it.name, name: f.name, docs: f.docs || "" });
        }
      } else if ("enum" in inner) {
        for (const vid of inner.enum.variants || []) {
          const v = idGet(idx, vid);
          if (v && v.name)
            variants.push({ typeName: it.name, name: v.name, docs: v.docs || "" });
        }
      }
    }
  }

  for (const it of Object.values(idx)) {
    const inner = it.inner || {};
    if (!("impl" in inner)) continue;
    const im = inner.impl;
    if (im.trait) continue;
    const forId = im.for?.resolved_path?.id;
    const typeName = forId != null ? entryIdToName.get(forId) : undefined;
    if (!typeName) continue;
    for (const mid of im.items || []) {
      const m = idGet(idx, mid);
      if (!m || !("function" in (m.inner || {}))) continue;
      if (m.visibility !== "public") continue;
      if (!m.docs) continue; // documented API surface only
      methods.push({
        typeName,
        name: m.name,
        docs: m.docs,
        sig: m.inner.function.sig,
        isAsync: !!m.inner.function.header?.is_async,
      });
    }
  }

  return { types, methods, fields, variants };
}

function build(facadeDoc, clientDoc) {
  const a = collectSurface(facadeDoc, FACADE_TYPES);
  const b = collectSurface(clientDoc, CLIENT_TYPES);
  const types = [...a.types, ...b.types];
  const methods = [...a.methods, ...b.methods];
  const fields = [...a.fields, ...b.fields];
  const variants = [...a.variants, ...b.variants];

  const completions = [];
  const seenCompletion = new Set();
  const hoversBySymbol = new Map();
  const signatures = [];

  const addCompletion = (item) => {
    const key = `${item.kind}:${item.label}`;
    if (seenCompletion.has(key)) return;
    seenCompletion.add(key);
    completions.push(item);
  };
  const addHover = (symbol, contents) => {
    if (!symbol || !contents) return;
    const prev = hoversBySymbol.get(symbol);
    if (prev && prev.includes(contents)) return;
    hoversBySymbol.set(symbol, prev ? `${prev}\n\n---\n\n${contents}` : contents);
  };
  const firstLine = (docs) => (docs || "").trim().split("\n\n")[0].trim();

  for (const t of types) {
    const doc = firstLine(t.docs);
    addCompletion({
      label: t.name,
      kind: "struct",
      detail: `camunda_orchestration_sdk`,
      documentation: doc || undefined,
    });
    addHover(
      t.name,
      `**\`struct ${t.name}\`** — camunda_orchestration_sdk${doc ? `\n\n${doc}` : ""}`,
    );
  }

  for (const m of methods) {
    const inputs = (m.sig.inputs || []).filter(([n]) => n !== "self");
    const argLabels = inputs.map(([n, ty]) => `${n}: ${renderType(ty)}`);
    const output = m.sig.output ? renderType(m.sig.output) : null;
    const asyncKw = m.isAsync ? "async " : "";
    const retSuffix = output && output !== "()" ? ` -> ${output}` : "";
    const sigLabel = `${asyncKw}fn ${m.name}(${argLabels.join(", ")})${retSuffix}`;
    const snippetArgs = inputs.map(([n], i) => `\${${i + 1}:${n}}`).join(", ");
    const doc = firstLine(m.docs);

    addCompletion({
      label: m.name,
      kind: "method",
      insertText: `${m.name}(${snippetArgs})`,
      snippet: true,
      detail: sigLabel,
      documentation: doc || undefined,
    });
    addHover(m.name, `**\`${sigLabel}\`**${doc ? `\n\n${doc}` : ""}`);
    if (argLabels.length) {
      signatures.push({
        trigger: m.name,
        label: sigLabel,
        documentation: doc || undefined,
        parameters: argLabels.map((l) => ({ label: l })),
      });
    }
  }

  for (const f of fields) {
    const doc = firstLine(f.docs);
    if (!doc) continue;
    addCompletion({
      label: f.name,
      kind: "field",
      detail: `${f.typeName}.${f.name}`,
      documentation: doc,
    });
    addHover(f.name, `**\`${f.typeName}.${f.name}\`**\n\n${doc}`);
  }

  for (const v of variants) {
    const doc = firstLine(v.docs);
    addCompletion({
      label: v.name,
      kind: "enum",
      detail: `${v.typeName}::${v.name}`,
      documentation: doc || undefined,
    });
    addHover(
      v.name,
      `**\`${v.typeName}::${v.name}\`**${doc ? `\n\n${doc}` : ""}`,
    );
  }

  const hovers = [...hoversBySymbol.entries()].map(([symbol, contents]) => ({
    symbol,
    contents,
  }));

  completions.sort(
    (x, y) => x.label.localeCompare(y.label) || x.kind.localeCompare(y.kind),
  );
  hovers.sort((x, y) => x.symbol.localeCompare(y.symbol));
  signatures.sort(
    (x, y) =>
      x.trigger.localeCompare(y.trigger) || x.label.localeCompare(y.label),
  );

  return {
    monacoLang: "rust",
    triggerCharacters: ["."],
    completions,
    hovers,
    signatures,
  };
}

// --- drive ------------------------------------------------------------------

function stripUndefined(v) {
  return JSON.parse(JSON.stringify(v));
}

function main() {
  const check = process.argv.includes("--check");
  const version = sdkVersion();
  const docs = acquireDocs();
  let block;
  try {
    block = stripUndefined(build(docs.facade, docs.client));
  } finally {
    docs.cleanup();
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  manifest.intellisense = [block];
  const out = JSON.stringify(manifest, null, 2) + "\n";

  if (check) {
    const current = readFileSync(MANIFEST, "utf8");
    if (current !== out) {
      fail(
        "nano-ide.ext.json intellisense is stale. Run 'npm run gen:intellisense' and commit.",
      );
    }
    console.log(
      `gen-intellisense: up to date (SDK ${version}, ${block.completions.length} completions).`,
    );
    return;
  }

  writeFileSync(MANIFEST, out);
  console.log(
    `gen-intellisense: wrote ${block.completions.length} completions, ` +
      `${block.hovers.length} hovers, ${block.signatures.length} signatures ` +
      `from SDK ${version}.`,
  );
}

main();
