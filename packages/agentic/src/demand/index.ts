/**
 * @nanobpm/agentic-demand — the demand×supply model for the Nano agentic
 * protocol (ADR 0056, slice S4).
 *
 * A **read-only mirror + enrolment gate**: it reads the deployed models'
 * `taskDefinition` leaves from the engine's C8 REST API ({@link httpC8RestReader},
 * {@link readDeployedTaskDefinitions}), buckets them by network prefix, and diffs
 * that demand against the live supply — the S2 presence registry resolved through
 * the S3 vocabulary ({@link computeDemandSupply}) — to surface, per network, the
 * *missing agent types* (`demand ∖ supply`) and the SLO state (missing-agent RED
 * folded together with the S3 diversity SLO).
 *
 * It does NOT match-make: it never places work on a worker or holds a seat's job.
 * Active placement is explicitly out of scope for v1. Nothing here rides the
 * Camunda-8 engine or its transport — the C8 REST read is an ordinary read over a
 * separate connection; the engine and the C8 job protocol stay frozen.
 *
 * The wire contract (routing-token grammar, `demand` payload) lives in
 * `@nanobpm/agentic-protocol`; the registry rows and vocab resolver come from
 * `@nanobpm/agentic-vocab`. This package builds on both and never redefines them.
 */

export { scanTaskDefinitions, distinctTaskTypes, type TaskDefinitionLeaf } from "./taskdef.ts";

export {
  httpC8RestReader,
  readDeployedTaskDefinitions,
  readDeployedTaskTypes,
  type C8RestReader,
  type FetchLike,
  type HttpC8RestReaderOptions,
} from "./c8-rest.ts";

export {
  computeDemandSupply,
  toDemandPayloads,
  type DemandSupplyInput,
  type DemandSupplyReport,
  type NetworkDemand,
  type TokenDemand,
  type SloStatus,
} from "./model.ts";
