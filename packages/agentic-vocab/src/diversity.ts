/**
 * The diversity SLO — `family(#red) ≠ family(#blue)`.
 *
 * A role may declare `seatsDistinctFamily: true` (STRICT opt-in) to require its
 * seats be filled by distinct families. The SLO grades an assignment of seats to
 * families red / amber / green:
 *
 *  - GREEN  — no role has two seats sharing a family.
 *  - AMBER  — a same-family collision on a WARN-DEFAULT role (one that did NOT
 *             opt into `seatsDistinctFamily`): tolerated, but surfaced.
 *  - RED    — a same-family collision on a STRICT role (`seatsDistinctFamily`):
 *             an SLO violation.
 *
 * Warn-default is the point of the "strict opt-in per role": every role wants
 * family diversity, but only a role that opts in makes a collision RED; elsewhere
 * a collision is an AMBER warning, never a hard failure.
 *
 * The assignment can be given explicitly (seat→family) or CORRELATED from the S2
 * presence registry: {@link correlateRegistry} resolves each registered worker's
 * capability to the roles it may fill and seats them deterministically, so the
 * live registry's family mix is graded against the same SLO.
 */
import type { Capability } from "@nanobpm/agentic-protocol";
import type { ResolvedRole, VocabResolver } from "./resolver.ts";

export type DiversityStatus = "green" | "amber" | "red";

/** One seat of a role filled by a worker of a given family. */
export interface SeatAssignment {
  /** The seat label (named seat, or a synthesised index for counted seats). */
  readonly seat: string;
  /** The enrolment family occupying the seat. */
  readonly family: string;
  /** The worker instance occupying the seat, when known (registry correlation). */
  readonly instance?: string;
}

/** The diversity grade for a single role. */
export interface RoleDiversity {
  /** The role's routing token. */
  readonly token: string;
  /** Whether the role opted into strict distinct-family seating. */
  readonly seatsDistinctFamily: boolean;
  /** The seats considered, in seat order. */
  readonly assignments: readonly SeatAssignment[];
  /** Families that fill more than one seat of this role (the collisions). */
  readonly collidingFamilies: readonly string[];
  /** This role's grade. */
  readonly status: DiversityStatus;
}

/** The overall diversity report across every graded role. */
export interface DiversityReport {
  /** The worst grade across all roles (red > amber > green). */
  readonly status: DiversityStatus;
  /** Per-role grades, sorted by token. */
  readonly roles: readonly RoleDiversity[];
}

const SEVERITY: Record<DiversityStatus, number> = { green: 0, amber: 1, red: 2 };

function worst(a: DiversityStatus, b: DiversityStatus): DiversityStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function collidingFamilies(assignments: readonly SeatAssignment[]): string[] {
  const counts = new Map<string, number>();
  for (const { family } of assignments) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const colliding: string[] = [];
  for (const [family, count] of counts) {
    if (count > 1) colliding.push(family);
  }
  colliding.sort();
  return colliding;
}

function gradeRole(role: ResolvedRole, assignments: readonly SeatAssignment[]): RoleDiversity {
  const colliding = collidingFamilies(assignments);
  const status: DiversityStatus =
    colliding.length === 0 ? "green" : role.seatsDistinctFamily ? "red" : "amber";
  return {
    token: role.token,
    seatsDistinctFamily: role.seatsDistinctFamily,
    assignments,
    collidingFamilies: colliding,
    status,
  };
}

/**
 * Grade an explicit seat assignment. `assignments` maps a role's routing token
 * to the families seated in it. Only roles known to the resolver are graded; an
 * unknown token is ignored (there is nothing to grade it against).
 */
export function computeDiversity(
  resolver: VocabResolver,
  assignments: ReadonlyMap<string, readonly SeatAssignment[]>,
): DiversityReport {
  const roles: RoleDiversity[] = [];
  let status: DiversityStatus = "green";
  for (const [token, seatAssignments] of assignments) {
    const role = resolver.roleForToken(token);
    if (role === undefined) continue;
    const graded = gradeRole(role, seatAssignments);
    roles.push(graded);
    status = worst(status, graded.status);
  }
  roles.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { status, roles };
}

/** A registered worker as seen on the S2 presence registry (structural). */
export interface RegisteredWorker {
  /** The worker instance id. */
  readonly instance: string;
  /** The declared enrolment capability (its `family` fills a seat). */
  readonly capability: Capability;
}

/** Seat labels for a role: its named seats, or synthesised `0..n-1` for a count. */
function seatLabels(role: ResolvedRole): string[] {
  if (typeof role.seats === "number") {
    return Array.from({ length: role.seats }, (_unused, index) => String(index));
  }
  return [...role.seats];
}

/**
 * Correlate the live S2 registry against the vocab and grade its diversity.
 *
 * Each registered worker is resolved to the roles it may fill; for every role,
 * the workers that qualify are seated deterministically (sorted by instance)
 * into the role's seats, and the resulting family mix is graded by
 * {@link computeDiversity}. Workers with no declared family, and roles with no
 * qualifying worker, are skipped. Overflow workers beyond a role's seat count do
 * not take a seat (they are surplus supply, not a diversity collision).
 */
export function correlateRegistry(
  resolver: VocabResolver,
  workers: readonly RegisteredWorker[],
): DiversityReport {
  const sorted = [...workers].sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0));
  const perRole = new Map<string, SeatAssignment[]>();

  for (const role of resolver.roles()) {
    const seats = seatLabels(role);
    if (seats.length === 0) continue;
    const qualifying = sorted.filter(
      (worker) => worker.capability.family !== undefined && satisfies(resolver, role, worker.capability),
    );
    const assignments: SeatAssignment[] = [];
    for (let index = 0; index < seats.length && index < qualifying.length; index += 1) {
      const worker = qualifying[index];
      const family = worker.capability.family;
      if (family === undefined) continue;
      assignments.push({ seat: seats[index], family, instance: worker.instance });
    }
    if (assignments.length > 0) {
      perRole.set(role.token, assignments);
    }
  }

  return computeDiversity(resolver, perRole);
}

function satisfies(resolver: VocabResolver, role: ResolvedRole, capability: Capability): boolean {
  return resolver.resolve(capability).roles.some((matched) => matched.token === role.token);
}
