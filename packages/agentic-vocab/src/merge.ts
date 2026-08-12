/**
 * Author-extension merge — extend the core vocabulary in the SAME schema.
 *
 * Authors do not get a second schema for extensions (S0 invariant 6): they hand
 * a {@link VocabDocument} in the exact core shape and {@link mergeVocab} deep-
 * merges it over a base (the {@link CORE_VOCAB} by default). The merge is
 * structural and deterministic:
 *
 *  - networks / subnetworks are merged recursively (union of names);
 *  - a role present in both is merged field-by-field, the extension winning per
 *    field, so an author can retune one attribute (e.g. bump `weight` or add a
 *    `seatsDistinctFamily`) without restating the whole role;
 *  - a role/network present only in the extension is added;
 *  - `version` becomes the MAX of the two, so an extension can advance it.
 *
 * The merged document is re-validated against the S0 schema and returned fresh —
 * neither input is mutated, and a merge that produces an invalid artifact throws
 * {@link VocabDocumentError} rather than yielding a subtly broken vocab.
 */
import { validateVocabDocument } from "@nanobpm/agentic-protocol";
import type { VocabDocument, VocabNetwork, VocabRole } from "@nanobpm/agentic-protocol";
import { CORE_VOCAB } from "./core-vocab.ts";
import { VocabDocumentError } from "./resolver.ts";

function mergeRole(base: VocabRole, ext: VocabRole): VocabRole {
  const merged: {
    requires?: readonly string[];
    weight?: number;
    seats?: number | readonly string[];
    seatsDistinctFamily?: boolean;
  } = {};
  const requires = ext.requires ?? base.requires;
  if (requires !== undefined) merged.requires = [...requires];
  const weight = ext.weight ?? base.weight;
  if (weight !== undefined) merged.weight = weight;
  const seats = ext.seats ?? base.seats;
  if (seats !== undefined) merged.seats = typeof seats === "number" ? seats : [...seats];
  const seatsDistinctFamily = ext.seatsDistinctFamily ?? base.seatsDistinctFamily;
  if (seatsDistinctFamily !== undefined) merged.seatsDistinctFamily = seatsDistinctFamily;
  return merged;
}

const EMPTY_ROLE: VocabRole = {};

function cloneRole(role: VocabRole): VocabRole {
  return mergeRole(EMPTY_ROLE, role);
}

function mergeRoles(
  base: Readonly<Record<string, VocabRole>> | undefined,
  ext: Readonly<Record<string, VocabRole>> | undefined,
): Record<string, VocabRole> | undefined {
  if (base === undefined && ext === undefined) return undefined;
  const out: Record<string, VocabRole> = {};
  for (const [name, role] of Object.entries(base ?? {})) {
    out[name] = cloneRole(role);
  }
  for (const [name, role] of Object.entries(ext ?? {})) {
    const existing = out[name];
    out[name] = existing === undefined ? cloneRole(role) : mergeRole(existing, role);
  }
  return out;
}

function mergeNetwork(base: VocabNetwork | undefined, ext: VocabNetwork): VocabNetwork {
  const roles = mergeRoles(base?.roles, ext.roles);
  const subnetworks = mergeNetworks(base?.subnetworks, ext.subnetworks);
  const merged: { roles?: Record<string, VocabRole>; subnetworks?: Record<string, VocabNetwork> } = {};
  if (roles !== undefined) merged.roles = roles;
  if (subnetworks !== undefined) merged.subnetworks = subnetworks;
  return merged;
}

function mergeNetworks(
  base: Readonly<Record<string, VocabNetwork>> | undefined,
  ext: Readonly<Record<string, VocabNetwork>> | undefined,
): Record<string, VocabNetwork> | undefined {
  if (base === undefined && ext === undefined) return undefined;
  const out: Record<string, VocabNetwork> = {};
  for (const [name, network] of Object.entries(base ?? {})) {
    out[name] = mergeNetwork(undefined, network);
  }
  for (const [name, network] of Object.entries(ext ?? {})) {
    out[name] = mergeNetwork(out[name], network);
  }
  return out;
}

/**
 * Merge an author `extension` over a `base` vocab (default {@link CORE_VOCAB}),
 * returning a fresh, re-validated {@link VocabDocument}.
 *
 * @throws VocabDocumentError if either input or the merged result is not a valid
 *   vocab artifact.
 */
export function mergeVocab(extension: VocabDocument, base: VocabDocument = CORE_VOCAB): VocabDocument {
  for (const [label, doc] of [
    ["base", base],
    ["extension", extension],
  ] as const) {
    const check = validateVocabDocument(doc);
    if (!check.ok) {
      throw new VocabDocumentError(check.errors.map((e) => ({ path: `${label}:${e.path}`, message: e.message })));
    }
  }

  const merged = {
    version: Math.max(base.version, extension.version),
    networks: mergeNetworks(base.networks, extension.networks) ?? {},
  };

  const result = validateVocabDocument(merged);
  if (!result.ok) {
    throw new VocabDocumentError(result.errors.map((e) => ({ path: `merged:${e.path}`, message: e.message })));
  }
  return result.value;
}
