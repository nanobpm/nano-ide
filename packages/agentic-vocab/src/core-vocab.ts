/**
 * The opinionated core vocabulary.
 *
 * Ships working out of the box (S0 invariant 6): the standard agentic SDLC
 * networks — `planning.*`, `qa.*`, `implementation.*`, `ci.*` — plus the bare
 * `decide` role, each gated by an enrolment `requires` predicate and sized with
 * seats. Authors EXTEND this in the SAME schema (see {@link mergeVocab}); there
 * is no second schema for extensions.
 *
 * Seats & diversity: review roles carry two named seats `#red` / `#blue` with
 * `seatsDistinctFamily: true` so the diversity SLO (S3) fails RED when both
 * reviewers are the same family. Non-review roles leave `seatsDistinctFamily`
 * off (warn-default): a same-family collision there is AMBER, not RED.
 *
 * Capability is NEVER in the token — `requires` is the registry gate, evaluated
 * over the declared enrolment capability (cognition/weight/family/host).
 */
import type { VocabDocument } from "@nanobpm/agentic-protocol";

/** The current core-vocabulary artifact version. */
export const CORE_VOCAB_VERSION = 1;

/**
 * The frozen core vocabulary document. Deep-frozen so a consumer cannot mutate
 * the shared artifact; author extensions go through {@link mergeVocab}, which
 * returns a fresh document.
 */
export const CORE_VOCAB: VocabDocument = deepFreeze({
  version: CORE_VOCAB_VERSION,
  networks: {
    planning: {
      roles: {
        planner: { requires: ["cognition=planning"], weight: 5, seats: 1 },
        reviewer: {
          requires: ["cognition=planning"],
          weight: 4,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
      },
    },
    qa: {
      roles: {
        tester: { requires: ["cognition=qa"], weight: 3, seats: 2 },
        reviewer: {
          requires: ["cognition=qa"],
          weight: 3,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
      },
    },
    implementation: {
      roles: {
        senior: { requires: ["cognition=implementation", "weight>=4"], weight: 5, seats: 1 },
        junior: { requires: ["cognition=implementation"], weight: 2, seats: 3 },
        reviewer: {
          requires: ["cognition=implementation"],
          weight: 4,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
      },
    },
    ci: {
      roles: {
        runner: { requires: ["cognition=ci"], weight: 1, seats: 1 },
      },
    },
    // The bare `decide` role (single-segment token): a self-named top-level role
    // the resolver collapses to the network-less token `decide`.
    decide: {
      roles: {
        decide: { requires: ["cognition=decide"], weight: 5, seats: 1 },
      },
    },
  },
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
