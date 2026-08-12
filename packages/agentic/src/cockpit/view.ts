/**
 * The cockpit view-model — S8.
 *
 * A pure, deterministic projection of the S4 {@link DemandSupplyReport} onto the
 * shape the cockpit renders: a per-network demand×supply matrix, a red light per
 * *missing agent type*, and the diversity-SLO state (from S3, carried through S4).
 *
 * It is deliberately framework-free and side-effect-free: the same report always
 * yields the same {@link CockpitView}, so it is safe to diff frame-to-frame, to
 * snapshot in a test, and to render identically whether the page is embedded in
 * the console (App View) or served standalone — the view is the single source of
 * truth both render paths consume.
 */
import type { DemandSupplyReport, NetworkDemand, SloStatus, TokenDemand } from "../demand/index.ts";
import type { DiversityReport } from "../vocab/index.ts";

export type { SloStatus } from "../demand/index.ts";

/** A three-state status light rendered as a coloured dot + label. */
export interface CockpitLight {
  /** Stable id for the DOM node / keyed diff. */
  readonly id: string;
  /** Human label shown next to the dot. */
  readonly label: string;
  /** The grade the dot colours to. */
  readonly status: SloStatus;
  /** Optional one-line detail (tooltip / secondary text). */
  readonly detail?: string;
}

/** One demanded routing token as a matrix cell. */
export interface CockpitTokenRow {
  /** The demanded routing token. */
  readonly token: string;
  /** How many registered workers currently serve it. */
  readonly supply: number;
  /** The serving worker instances (provenance for the drill-in), sorted. */
  readonly instances: readonly string[];
  /** False when no worker serves it — a missing agent type. */
  readonly satisfied: boolean;
  /** GREEN when served, RED when missing. */
  readonly status: SloStatus;
}

/** One network prefix as a matrix row. */
export interface CockpitNetworkRow {
  /** The network prefix bucket. */
  readonly network: string;
  /** Every demanded token in the bucket, sorted by token. */
  readonly tokens: readonly CockpitTokenRow[];
  /** The demanded tokens in this bucket with zero supply, sorted. */
  readonly missing: readonly string[];
  /** RED when the row has any missing agent type, else GREEN. */
  readonly status: SloStatus;
}

/** The full renderable cockpit view. */
export interface CockpitView {
  /** The overall SLO state: worst of missing-agent and diversity. */
  readonly status: SloStatus;
  /** The demand×supply matrix, one row per network, sorted by network. */
  readonly networks: readonly CockpitNetworkRow[];
  /** Every missing agent type across all networks, sorted and de-duplicated. */
  readonly missing: readonly string[];
  /** One RED light per missing agent type (empty when nothing is missing). */
  readonly missingLights: readonly CockpitLight[];
  /** The S3 diversity report, carried through unchanged for detail rendering. */
  readonly diversity: DiversityReport;
  /** A single light summarising the diversity SLO. */
  readonly diversityLight: CockpitLight;
  /**
   * Deployed task types that are not valid routing tokens (ordinary,
   * non-agentic C8 jobs) — surfaced so an operator can spot a mistyped token,
   * excluded from the agentic accounting.
   */
  readonly nonAgentic: readonly string[];
}

function tokenRow(token: TokenDemand): CockpitTokenRow {
  return {
    token: token.token,
    supply: token.supply,
    instances: token.instances,
    satisfied: token.satisfied,
    status: token.satisfied ? "green" : "red",
  };
}

function networkRow(network: NetworkDemand): CockpitNetworkRow {
  return {
    network: network.network,
    tokens: network.tokens.map(tokenRow),
    missing: network.missing,
    status: network.missing.length > 0 ? "red" : "green",
  };
}

function missingLight(token: string): CockpitLight {
  return {
    id: `missing:${token}`,
    label: token,
    status: "red",
    detail: "missing agent type — no registered worker serves this token",
  };
}

function diversityDetail(diversity: DiversityReport): string {
  const offenders = diversity.roles.filter((role) => role.status !== "green");
  if (offenders.length === 0) return "family(#red) ≠ family(#blue) holds for every role";
  return offenders
    .map((role) => `${role.token}: ${role.collidingFamilies.join(", ")} (${role.status})`)
    .join("; ");
}

function diversityLight(diversity: DiversityReport): CockpitLight {
  return {
    id: "diversity",
    label: "diversity SLO",
    status: diversity.status,
    detail: diversityDetail(diversity),
  };
}

/**
 * Derive the renderable cockpit view from an S4 demand×supply report.
 *
 * Pure and total: every list is already sorted by S4, so the derived view is
 * stable and diff-friendly; no input mutates and no I/O happens.
 */
export function cockpitView(report: DemandSupplyReport): CockpitView {
  return {
    status: report.status,
    networks: report.networks.map(networkRow),
    missing: report.missing,
    missingLights: report.missing.map(missingLight),
    diversity: report.diversity,
    diversityLight: diversityLight(report.diversity),
    nonAgentic: report.nonAgentic,
  };
}
