import { isSeatLabel, isSegmentName } from "../token.ts";

/**
 * The versioned vocab artifact: the capability→token map applied over the
 * channel (REGISTER → SERVE). It is authoritative and out-of-band from any
 * worker — no capability→token map is ever baked into a worker.
 *
 * Core vocabulary ships opinionated and works out of the box; authors extend it
 * by adding networks/subnetworks/roles in THIS SAME schema (there is no second
 * schema for extensions).
 *
 * Per-role attributes:
 *  - `requires`             — enrolment capability requirements (the registry
 *                             gate). These gate WHO may fill the role; they are
 *                             never encoded in the routing token.
 *  - `weight`               — cognition weight for the role.
 *  - `seats`                — either a seat count (integer ≥ 0) or an explicit
 *                             list of named seats (each a valid seat label).
 *  - `seatsDistinctFamily`  — diversity SLO: when true, seats of this role must
 *                             be filled by distinct families (e.g. #red ≠ #blue).
 */
export interface VocabRole {
  readonly requires?: readonly string[];
  readonly weight?: number;
  readonly seats?: number | readonly string[];
  readonly seatsDistinctFamily?: boolean;
}

export interface VocabNetwork {
  readonly roles?: Readonly<Record<string, VocabRole>>;
  readonly subnetworks?: Readonly<Record<string, VocabNetwork>>;
}

export interface VocabDocument {
  readonly version: number;
  readonly networks: Readonly<Record<string, VocabNetwork>>;
}

export interface VocabError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type VocabValidationResult =
  | { readonly ok: true; readonly value: VocabDocument }
  | { readonly ok: false; readonly errors: readonly VocabError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLE_KEYS: ReadonlySet<string> = new Set([
  "requires",
  "weight",
  "seats",
  "seatsDistinctFamily",
]);
const NETWORK_KEYS: ReadonlySet<string> = new Set(["roles", "subnetworks"]);
const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["version", "networks"]);

function validateRole(role: unknown, path: string, errors: VocabError[]): void {
  if (!isPlainObject(role)) {
    errors.push({ path, code: "role-not-object", message: "role must be an object" });
    return;
  }
  for (const key of Object.keys(role)) {
    if (!ROLE_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, code: "unknown-role-field", message: `unknown role field: ${key}` });
    }
  }

  if ("requires" in role) {
    const requires = role.requires;
    if (!Array.isArray(requires) || !requires.every((entry) => typeof entry === "string")) {
      errors.push({
        path: `${path}.requires`,
        code: "bad-requires",
        message: "requires must be an array of strings",
      });
    }
  }

  if ("weight" in role) {
    const weight = role.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      errors.push({ path: `${path}.weight`, code: "bad-weight", message: "weight must be a finite number" });
    }
  }

  if ("seats" in role) {
    const seats = role.seats;
    if (typeof seats === "number") {
      if (!Number.isInteger(seats) || seats < 0) {
        errors.push({ path: `${path}.seats`, code: "bad-seats", message: "seats count must be a non-negative integer" });
      }
    } else if (Array.isArray(seats)) {
      seats.forEach((seat, index) => {
        if (typeof seat !== "string" || !isSeatLabel(seat)) {
          errors.push({
            path: `${path}.seats[${index}]`,
            code: "bad-seat-label",
            message: `named seat must be a valid seat label: ${String(seat)}`,
          });
        }
      });
    } else {
      errors.push({
        path: `${path}.seats`,
        code: "bad-seats",
        message: "seats must be a non-negative integer or an array of seat labels",
      });
    }
  }

  if ("seatsDistinctFamily" in role && typeof role.seatsDistinctFamily !== "boolean") {
    errors.push({
      path: `${path}.seatsDistinctFamily`,
      code: "bad-seats-distinct-family",
      message: "seatsDistinctFamily must be a boolean",
    });
  }
}

function validateNetwork(network: unknown, path: string, errors: VocabError[]): void {
  if (!isPlainObject(network)) {
    errors.push({ path, code: "network-not-object", message: "network must be an object" });
    return;
  }
  for (const key of Object.keys(network)) {
    if (!NETWORK_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, code: "unknown-network-field", message: `unknown network field: ${key}` });
    }
  }

  if ("roles" in network) {
    const roles = network.roles;
    if (!isPlainObject(roles)) {
      errors.push({ path: `${path}.roles`, code: "bad-roles", message: "roles must be an object" });
    } else {
      for (const [roleName, role] of Object.entries(roles)) {
        if (!isSegmentName(roleName)) {
          errors.push({
            path: `${path}.roles.${roleName}`,
            code: "bad-role-name",
            message: `invalid role name: ${roleName}`,
          });
        }
        validateRole(role, `${path}.roles.${roleName}`, errors);
      }
    }
  }

  if ("subnetworks" in network) {
    const subnetworks = network.subnetworks;
    if (!isPlainObject(subnetworks)) {
      errors.push({ path: `${path}.subnetworks`, code: "bad-subnetworks", message: "subnetworks must be an object" });
    } else {
      for (const [subName, sub] of Object.entries(subnetworks)) {
        if (!isSegmentName(subName)) {
          errors.push({
            path: `${path}.subnetworks.${subName}`,
            code: "bad-subnetwork-name",
            message: `invalid subnetwork name: ${subName}`,
          });
        }
        validateNetwork(sub, `${path}.subnetworks.${subName}`, errors);
      }
    }
  }
}

/**
 * Validate an unknown value against the vocab-artifact schema. On success the
 * returned `value` is a newly constructed {@link VocabDocument} normalized from
 * the input — it does not share referential identity with `input`.
 */
export function validateVocabDocument(input: unknown): VocabValidationResult {
  const errors: VocabError[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "$", code: "not-object", message: "vocab document must be an object" }] };
  }
  for (const key of Object.keys(input)) {
    if (!DOCUMENT_KEYS.has(key)) {
      errors.push({ path: `$.${key}`, code: "unknown-document-field", message: `unknown document field: ${key}` });
    }
  }

  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    errors.push({ path: "$.version", code: "bad-version", message: "version must be an integer ≥ 1" });
  }

  const networks = input.networks;
  if (!isPlainObject(networks)) {
    errors.push({ path: "$.networks", code: "bad-networks", message: "networks must be an object" });
  } else {
    for (const [networkName, network] of Object.entries(networks)) {
      if (!isSegmentName(networkName)) {
        errors.push({
          path: `$.networks.${networkName}`,
          code: "bad-network-name",
          message: `invalid network name: ${networkName}`,
        });
      }
      validateNetwork(network, `$.networks.${networkName}`, errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: narrowDocument(input) };
}

// Reached only after validateVocabDocument confirmed the shape; the recursive
// structural checks above guarantee every field matches VocabDocument.
function narrowDocument(input: Record<string, unknown>): VocabDocument {
  const version = input.version;
  const networks = input.networks;
  if (typeof version !== "number" || !isPlainObject(networks)) {
    throw new Error("narrowDocument called on an unvalidated value");
  }
  const out: Record<string, VocabNetwork> = {};
  for (const [name, network] of Object.entries(networks)) {
    out[name] = narrowNetwork(network);
  }
  return { version, networks: out };
}

function narrowNetwork(input: unknown): VocabNetwork {
  if (!isPlainObject(input)) {
    throw new Error("narrowNetwork called on an unvalidated value");
  }
  const result: { roles?: Record<string, VocabRole>; subnetworks?: Record<string, VocabNetwork> } = {};
  if (isPlainObject(input.roles)) {
    const roles: Record<string, VocabRole> = {};
    for (const [roleName, role] of Object.entries(input.roles)) {
      roles[roleName] = narrowRole(role);
    }
    result.roles = roles;
  }
  if (isPlainObject(input.subnetworks)) {
    const subnetworks: Record<string, VocabNetwork> = {};
    for (const [subName, sub] of Object.entries(input.subnetworks)) {
      subnetworks[subName] = narrowNetwork(sub);
    }
    result.subnetworks = subnetworks;
  }
  return result;
}

function narrowRole(input: unknown): VocabRole {
  if (!isPlainObject(input)) {
    throw new Error("narrowRole called on an unvalidated value");
  }
  const role: {
    requires?: readonly string[];
    weight?: number;
    seats?: number | readonly string[];
    seatsDistinctFamily?: boolean;
  } = {};
  const requires = input.requires;
  if (Array.isArray(requires) && requires.every((entry) => typeof entry === "string")) {
    role.requires = [...requires];
  }
  if (typeof input.weight === "number") {
    role.weight = input.weight;
  }
  const seats = input.seats;
  if (typeof seats === "number") {
    role.seats = seats;
  } else if (Array.isArray(seats) && seats.every((seat) => typeof seat === "string")) {
    role.seats = [...seats];
  }
  if (typeof input.seatsDistinctFamily === "boolean") {
    role.seatsDistinctFamily = input.seatsDistinctFamily;
  }
  return role;
}
