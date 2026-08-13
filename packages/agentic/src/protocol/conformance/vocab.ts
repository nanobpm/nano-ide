import type { VocabDocument } from "../vocab/schema.ts";

/**
 * Valid vocab documents (core-shaped + an author extension) and invalid ones
 * paired with the error code they must surface. Shared so the c8ctl client's
 * resolver is held to the same schema this repo's validator enforces.
 *
 * NOTE: the FULL opinionated core vocabulary is S3's deliverable; the valid
 * document below is a representative, schema-complete sample (it exercises
 * `requires`, `weight`, numeric `seats`, named `seats`, and
 * `seatsDistinctFamily`), not the canonical core artifact.
 */
export interface ValidVocab {
  readonly name: string;
  readonly document: VocabDocument;
}

export interface InvalidVocab {
  readonly name: string;
  readonly document: unknown;
  /** A `code` that MUST appear among the validation errors. */
  readonly expectedCode: string;
}

export const VALID_VOCABS: readonly ValidVocab[] = [
  {
    name: "core-shaped-sample",
    document: {
      version: 1,
      networks: {
        planning: {
          roles: {
            decide: { requires: ["cognition=reasoning"], weight: 3, seats: 1 },
          },
        },
        qa: {
          roles: {
            review: {
              requires: ["cognition=reasoning"],
              weight: 2,
              seats: ["red", "blue"],
              seatsDistinctFamily: true,
            },
          },
        },
        implementation: {
          roles: { senior: { weight: 3, seats: 4 } },
          subnetworks: {
            ci: { roles: { fix: { weight: 1, seats: 2 } } },
          },
        },
      },
    },
  },
  {
    name: "author-extension-merges-in-same-schema",
    document: {
      version: 2,
      networks: {
        support: {
          roles: {
            triage: { requires: ["host=on-call"], weight: 1, seats: 3 },
          },
        },
      },
    },
  },
];

export const INVALID_VOCABS: readonly InvalidVocab[] = [
  { name: "not-an-object", document: 42, expectedCode: "not-object" },
  { name: "missing-version", document: { networks: {} }, expectedCode: "bad-version" },
  { name: "zero-version", document: { version: 0, networks: {} }, expectedCode: "bad-version" },
  {
    name: "missing-networks",
    document: { version: 1 },
    expectedCode: "bad-networks",
  },
  {
    name: "unknown-document-field",
    document: { version: 1, networks: {}, extra: true },
    expectedCode: "unknown-document-field",
  },
  {
    name: "bad-network-name",
    document: { version: 1, networks: { "Bad Name": { roles: {} } } },
    expectedCode: "bad-network-name",
  },
  {
    name: "unknown-role-field",
    document: { version: 1, networks: { planning: { roles: { decide: { bogus: 1 } } } } },
    expectedCode: "unknown-role-field",
  },
  {
    name: "bad-weight",
    document: { version: 1, networks: { planning: { roles: { decide: { weight: "high" } } } } },
    expectedCode: "bad-weight",
  },
  {
    name: "bad-seats-count",
    document: { version: 1, networks: { planning: { roles: { decide: { seats: -1 } } } } },
    expectedCode: "bad-seats",
  },
  {
    name: "bad-named-seat",
    document: { version: 1, networks: { qa: { roles: { review: { seats: ["Red"] } } } } },
    expectedCode: "bad-seat-label",
  },
  {
    name: "bad-requires",
    document: { version: 1, networks: { planning: { roles: { decide: { requires: "x" } } } } },
    expectedCode: "bad-requires",
  },
  {
    name: "bad-seats-distinct-family",
    document: {
      version: 1,
      networks: { qa: { roles: { review: { seatsDistinctFamily: "yes" } } } },
    },
    expectedCode: "bad-seats-distinct-family",
  },
];
