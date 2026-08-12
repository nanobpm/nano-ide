/**
 * The vocab resolver — S3's REGISTER→SERVE core.
 *
 * The versioned vocab artifact (S0 {@link VocabDocument}) is the ONE
 * capability→token map; no map is ever baked into a worker. This resolver reads
 * it and, given a declared enrolment capability, produces the deterministic
 * SERVE token set the worker is entitled to fill — the `serve` reply to a
 * `register` handshake.
 *
 * Token derivation walks `networks → subnetworks → roles`, joining segments into
 * a routing token `network[.subnetwork…].role` (never a seat, never a
 * capability). One exception encodes a BARE (network-less) role such as
 * `decide`: a top-level role whose name equals its containing network and that
 * has no subnetworks collapses to the single-segment token `role` — the only way
 * the S0 network→role schema can express the bare tokens the grammar allows. So
 * `networks.decide.roles.decide` serves the token `decide`.
 */
import { formatToken, parseToken, validateVocabDocument } from "../protocol/index.ts";
import type { Capability, VocabDocument, VocabNetwork, VocabRole } from "../protocol/index.ts";
import { parseRequiresList, RequiresParseError, satisfiesRequires, type RequiresPredicate } from "./requires.ts";

/** A role flattened out of the vocab tree, with its derived routing token. */
export interface ResolvedRole {
  /** The leaf routing token (`network[.subnetwork…].role`, or a bare role). */
  readonly token: string;
  /** The network segment, absent for a bare role. */
  readonly network?: string;
  /** The subnetwork segments between network and role (possibly empty). */
  readonly subnetworks: readonly string[];
  /** The role segment. */
  readonly role: string;
  /** Cognition weight for the role, if declared. */
  readonly weight?: number;
  /** Normalised seats: a non-negative count, or the explicit named-seat list. */
  readonly seats: number | readonly string[];
  /** Diversity SLO opt-in: when true, seats must be filled by distinct families. */
  readonly seatsDistinctFamily: boolean;
  /** The parsed enrolment gate for the role. */
  readonly requires: readonly RequiresPredicate[];
}

/** The result of resolving one capability against the vocab. */
export interface Resolution {
  /** The SERVE token set — sorted, de-duplicated leaf tokens. */
  readonly tokens: readonly string[];
  /** The matched roles (sorted by token) the tokens came from. */
  readonly roles: readonly ResolvedRole[];
}

/** Raised when the document handed to the resolver is not a valid vocab artifact. */
export class VocabDocumentError extends Error {
  readonly errors: readonly { path: string; message: string }[];
  constructor(errors: readonly { path: string; message: string }[]) {
    super(`invalid vocab document: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    this.name = "VocabDocumentError";
    this.errors = errors;
  }
}

/**
 * Parse a role's `requires` gate, tagging any failure with the routing token so a
 * malformed predicate names the role that carries it (e.g. when merging author
 * extensions) instead of surfacing a bare, context-free {@link RequiresParseError}.
 */
function parseRequires(token: string, requires: readonly string[] | undefined): RequiresPredicate[] {
  try {
    return parseRequiresList(requires);
  } catch (error) {
    if (error instanceof RequiresParseError) {
      throw new VocabDocumentError([{ path: token, message: error.message }]);
    }
    throw error;
  }
}

function deriveToken(network: string, subnetworks: readonly string[], role: string): string {
  // A self-named top-level role denotes a rootless (network-less) role: the only
  // way the network→role schema can express a single-segment token like `decide`.
  if (subnetworks.length === 0 && network === role) {
    return formatToken({ subnetworks: [], role });
  }
  return formatToken({ network, subnetworks: [...subnetworks], role });
}

function normaliseSeats(seats: VocabRole["seats"]): number | readonly string[] {
  if (seats === undefined) return 1;
  if (typeof seats === "number") return seats;
  return [...seats];
}

export class VocabResolver {
  readonly #roles: readonly ResolvedRole[];
  readonly #byToken: ReadonlyMap<string, ResolvedRole>;
  readonly #version: number;

  /**
   * Build a resolver over a vocab document. The document is re-validated against
   * the S0 schema and every role's `requires` gate is parsed up front, so a
   * malformed gate fails loudly at construction rather than silently at match.
   */
  constructor(doc: VocabDocument) {
    const validation = validateVocabDocument(doc);
    if (!validation.ok) {
      throw new VocabDocumentError(validation.errors.map((e) => ({ path: e.path, message: e.message })));
    }
    const document = validation.value;
    this.#version = document.version;

    const roles: ResolvedRole[] = [];
    const collect = (network: string, subnetworks: readonly string[], node: VocabNetwork): void => {
      if (node.roles !== undefined) {
        for (const [roleName, role] of Object.entries(node.roles)) {
          const token = deriveToken(network, subnetworks, roleName);
          roles.push({
            token,
            ...(subnetworks.length === 0 && network === roleName ? {} : { network }),
            subnetworks: [...subnetworks],
            role: roleName,
            ...(role.weight === undefined ? {} : { weight: role.weight }),
            seats: normaliseSeats(role.seats),
            seatsDistinctFamily: role.seatsDistinctFamily === true,
            requires: parseRequires(token, role.requires),
          });
        }
      }
      if (node.subnetworks !== undefined) {
        for (const [subName, sub] of Object.entries(node.subnetworks)) {
          collect(network, [...subnetworks, subName], sub);
        }
      }
    };
    for (const [networkName, network] of Object.entries(document.networks)) {
      collect(networkName, [], network);
    }

    // Deterministic order + a token→role index; a duplicate token is a modelling
    // error (two roles cannot claim one routing token).
    roles.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    const byToken = new Map<string, ResolvedRole>();
    for (const role of roles) {
      if (byToken.has(role.token)) {
        throw new VocabDocumentError([{ path: role.token, message: `duplicate routing token: ${role.token}` }]);
      }
      byToken.set(role.token, role);
    }
    this.#roles = roles;
    this.#byToken = byToken;
  }

  /** The vocab artifact version this resolver was built from. */
  get version(): number {
    return this.#version;
  }

  /** Every role in the vocab, sorted by token. */
  roles(): readonly ResolvedRole[] {
    return this.#roles;
  }

  /** Every leaf token in the vocab, sorted. */
  tokens(): readonly string[] {
    return this.#roles.map((role) => role.token);
  }

  /** Look up a role by its routing token. */
  roleForToken(token: string): ResolvedRole | undefined {
    // Normalise through the grammar so `planning.planner` and any equivalent
    // spelling resolve identically.
    let key: string;
    try {
      key = formatToken(parseToken(token));
    } catch {
      return undefined;
    }
    return this.#byToken.get(key);
  }

  /**
   * Resolve a declared enrolment capability to its SERVE token set: every role
   * whose `requires` gate the capability satisfies. The token list is sorted and
   * de-duplicated, so the same capability always yields the same SERVE.
   */
  resolve(capability: Capability): Resolution {
    const matched = this.#roles.filter((role) => satisfiesRequires(role.requires, capability));
    return { tokens: matched.map((role) => role.token), roles: matched };
  }
}
