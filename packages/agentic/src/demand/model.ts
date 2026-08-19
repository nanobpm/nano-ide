/**
 * The demand×supply model — S4.
 *
 * Given the demand (the routing tokens deployed models ask for, as
 * `taskDefinition` leaves) and the supply (the live S2 registry, resolved to the
 * SERVE tokens each worker fills through the S3 vocab), this computes, per
 * network:
 *
 *  - **demand** — the distinct routing tokens the deployed models declare,
 *    bucketed by the token's network prefix;
 *  - **supply** — how many registered workers currently serve each token;
 *  - **missing agent type** — `demand ∖ supply`: a demanded token no registered
 *    worker can fill (the enrolment gap the cockpit lights up red);
 *  - **the SLO state** — the worst of the missing-agent signal (a missing token
 *    is RED) and the S3 diversity SLO (`family(#red) ≠ family(#blue)`).
 *
 * This is a **read-only mirror + enrolment gate**. It reads what the engine has
 * deployed and what the registry reports and reconciles the two; it does NOT
 * match-make — it never places work on, or holds a seat for, a worker. Active
 * placement is explicitly out of scope for v1.
 *
 * Supply resolution reuses the S3 {@link VocabResolver}: a worker *serves* a token
 * iff that token is in `resolver.resolve(worker.capability).tokens` — capability
 * is the enrolment attribute the vocab's `requires` gate reads, never part of the
 * token itself (design invariant 3).
 */
import { parseToken } from "../protocol/index.ts";
import type { DemandPayload } from "../protocol/index.ts";
import { correlateRegistry, type DiversityReport, type RegisteredWorker, type VocabResolver } from "../vocab/index.ts";

import { distinctTaskTypes, type TaskDefinitionLeaf } from "./taskdef.ts";

/** The SLO grade — same three-level scale as the S3 diversity SLO. */
export type SloStatus = "green" | "amber" | "red";

const SEVERITY: Record<SloStatus, number> = { green: 0, amber: 1, red: 2 };

function worst(a: SloStatus, b: SloStatus): SloStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** One demanded routing token and the live supply against it. */
export interface TokenDemand {
  /** The demanded routing token (a `taskDefinition` leaf's type). */
  readonly token: string;
  /** How many registered workers currently serve this token. */
  readonly supply: number;
  /** The instances serving it, sorted — provenance for the cockpit drill-in. */
  readonly instances: readonly string[];
  /** False when no registered worker serves it — a missing agent type. */
  readonly satisfied: boolean;
}

/** The demand×supply picture for one network prefix. */
export interface NetworkDemand {
  /** The network prefix bucket (`network` segment, or a bare token's own name). */
  readonly network: string;
  /** Every demanded token in the bucket, sorted by token. */
  readonly tokens: readonly TokenDemand[];
  /** The demanded tokens in this bucket with zero supply, sorted. */
  readonly missing: readonly string[];
}

/** The full demand×supply report. */
export interface DemandSupplyReport {
  /** Per-network demand×supply, sorted by network. */
  readonly networks: readonly NetworkDemand[];
  /** Every missing agent type across all networks, sorted and de-duplicated. */
  readonly missing: readonly string[];
  /** The S3 diversity SLO over the correlated live registry. */
  readonly diversity: DiversityReport;
  /** The overall SLO state: worst of the missing-agent signal and diversity. */
  readonly status: SloStatus;
  /**
   * Deployed `taskDefinition` types that carry NO `linkName="prompt"` linked
   * resource — ordinary (non-agentic) in-process C8 jobs the engine also runs
   * (e.g. the deterministic `pr.*` workers). Classification is by the prompt
   * signal, not the token string, so a prompt-less type is `nonAgentic` even when
   * it happens to parse as a routing token. Surfaced (not silently dropped) so an
   * operator can spot a mis-modelled task, but excluded from the agentic
   * demand×supply accounting.
   */
  readonly nonAgentic: readonly string[];
}

/** Input to {@link computeDemandSupply}. */
export interface DemandSupplyInput {
  /** Demand: the deployed `taskDefinition` leaves (order-insensitive). */
  readonly taskDefinitions: readonly TaskDefinitionLeaf[];
  /** Supply: the live S2 registry rows. */
  readonly workers: readonly RegisteredWorker[];
  /** The S3 resolver over the resolved vocabulary artifact. */
  readonly resolver: VocabResolver;
}

/**
 * A demanded token's bucket. For a valid routing token this is its network
 * prefix (or a bare token's own role). For an arbitrary agentic type that is not
 * a routing token (colon-form `senior:retro`, etc.) this is best-effort: the
 * segment before the first `:` when present, else the whole type — a synthetic
 * bucket so the leaf still surfaces as demand rather than being dropped. This is
 * only ever called for prompt-bearing (agentic) leaves; non-agentic leaves are
 * classified out before bucketing.
 */
function bucketOf(token: string): string {
  try {
    const parsed = parseToken(token);
    // A bare (network-less) token like `decide` buckets under its own role name.
    return parsed.network ?? parsed.role;
  } catch {
    const colon = token.indexOf(":");
    return colon > 0 ? token.slice(0, colon) : token;
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Compute the demand×supply model from deployed demand and live supply.
 *
 * Pure and deterministic: the same demand + registry + vocab always yields the
 * same report, with every list sorted, so it is safe to diff frame-to-frame and
 * to render straight into the cockpit.
 */
export function computeDemandSupply(input: DemandSupplyInput): DemandSupplyReport {
  const { workers, resolver } = input;

  // Supply index: each worker's SERVE token set, resolved once.
  const supplyByToken = new Map<string, string[]>();
  for (const worker of workers) {
    const tokens = resolver.resolve(worker.capability).tokens;
    for (const token of tokens) {
      const instances = supplyByToken.get(token);
      if (instances === undefined) supplyByToken.set(token, [worker.instance]);
      else instances.push(worker.instance);
    }
  }

  const demandTokens = distinctTaskTypes(input.taskDefinitions);
  // Agentic-ness is the prompt signal, OR-folded across every leaf of a type: a
  // type is agentic demand iff at least one deployed leaf carries a
  // `linkName="prompt"` linked resource. This is independent of the type string,
  // so colon-form fleet types (`senior:retro`) are admitted and prompt-less
  // deterministic `pr.*` tasks are excluded — regardless of token grammar.
  const agenticByToken = new Map<string, boolean>();
  for (const leaf of input.taskDefinitions) {
    agenticByToken.set(leaf.taskType, (agenticByToken.get(leaf.taskType) ?? false) || leaf.agentic);
  }
  const byNetwork = new Map<string, Map<string, TokenDemand>>();
  const nonAgentic: string[] = [];

  for (const token of demandTokens) {
    if (!(agenticByToken.get(token) ?? false)) {
      nonAgentic.push(token);
      continue;
    }
    const network = bucketOf(token);
    const instances = sortedUnique(supplyByToken.get(token) ?? []);
    const demand: TokenDemand = {
      token,
      supply: instances.length,
      instances,
      satisfied: instances.length > 0,
    };
    const bucket = byNetwork.get(network) ?? new Map<string, TokenDemand>();
    // A token can only appear once (distinctTaskTypes), so no merge is needed.
    bucket.set(token, demand);
    byNetwork.set(network, bucket);
  }

  const networks: NetworkDemand[] = [...byNetwork.entries()]
    .map(([network, tokenMap]) => {
      const tokens = [...tokenMap.values()].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
      const missing = tokens.filter((token) => !token.satisfied).map((token) => token.token);
      return { network, tokens, missing };
    })
    .sort((a, b) => (a.network < b.network ? -1 : a.network > b.network ? 1 : 0));

  const missing = sortedUnique(networks.flatMap((network) => network.missing));
  const diversity = correlateRegistry(resolver, workers);
  const missingStatus: SloStatus = missing.length > 0 ? "red" : "green";
  const status = worst(missingStatus, diversity.status);

  return {
    networks,
    missing,
    diversity,
    status,
    nonAgentic: [...nonAgentic].sort(),
  };
}

/**
 * Project the report onto the S0 `demand` message family — one {@link DemandPayload}
 * per network carrying its missing agent types, so the gap can cross the agentic
 * channel's control/facts lane. Emits an entry for every network (missing may be
 * empty), sorted by network, so a consumer sees a cleared network flip from a
 * non-empty `missing` back to `[]`.
 */
export function toDemandPayloads(report: DemandSupplyReport): DemandPayload[] {
  return report.networks.map((network) => ({ network: network.network, missing: network.missing }));
}
