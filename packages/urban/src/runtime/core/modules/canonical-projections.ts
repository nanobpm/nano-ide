// canonical-projections — register the framework's canonical engine-truth projections under their
// stable DSL names (ADR 0065, proposal point #1). This is the concrete use of the projection-name
// seam the read-model primitive established (`projectionRegistry.register({ name, sqlTable })`): it
// maps each unprefixed DSL name a `defineReadModel(...)` `exists(...)` reads
// (`urban_open_user_tasks`, `urban_instance_state`) onto its `_urban_`-prefixed physical sidecar
// table, so the SQL backend's `EXISTS` compiles against the real table while the domain model / DB
// Manager never sees it.
//
// Registration is idempotent (the registry no-ops a matching re-register), so calling this on every
// worker mount — the boot path in `workers.ts` — is safe. It is decoupled from schema provisioning:
// a read model must be able to reference these projections by name even in a process/app that has no
// datasource to provision the physical tables into.

import {
  INSTANCE_STATE_PROJECTION,
  INSTANCE_STATE_TABLE,
} from "./instance-state-store.ts";
import {
  OPEN_USER_TASKS_PROJECTION,
  OPEN_USER_TASKS_TABLE,
} from "./open-user-tasks-store.ts";
import { type ProjectionRegistry, projectionRegistry } from "../read-model.ts";

/** The canonical projection name → physical `_urban_` table mappings this task owns. */
export const CANONICAL_PROJECTIONS: ReadonlyArray<{ readonly name: string; readonly sqlTable: string }> = [
  { name: OPEN_USER_TASKS_PROJECTION, sqlTable: OPEN_USER_TASKS_TABLE },
  { name: INSTANCE_STATE_PROJECTION, sqlTable: INSTANCE_STATE_TABLE },
];

/**
 * Register the canonical engine-truth projections in a {@link ProjectionRegistry} (defaults to the
 * process-wide `projectionRegistry`), so a `defineReadModel(...)` authored anywhere can
 * `exists("urban_open_user_tasks", …)` / `exists("urban_instance_state", …)` and have the SQL backend
 * resolve them to the `_urban_`-prefixed physical tables. Idempotent.
 */
export function registerCanonicalProjections(registry: ProjectionRegistry = projectionRegistry): void {
  for (const projection of CANONICAL_PROJECTIONS) registry.register(projection);
}
