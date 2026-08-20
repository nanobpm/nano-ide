// `@nanobpm/urban-testkit/ai` — the AI-assertion surface for Urban app tests.
//
// The AI-judge & semantic-similarity assertion DSL (`assertThatText` and the
// record/replay adapters, judge/similarity matchers, and real-seam descriptors)
// was lifted into the standalone, engine- and framework-agnostic package
// `@nanobpm/ai-assert` (issue Magikcraft/nano-bpm#894, S3) so it is reusable
// anywhere. urban-testkit keeps its `/ai` subpath as a stable alias by
// re-exporting that package's entire public surface — a single source of truth,
// zero drift. There is no Urban coupling in this tier, so nothing is wrapped or
// adapted here (unlike the engine `assertThat*` surface, which forwards a
// `TestApp`): the surface is re-exported verbatim.
//
// `export *` re-exports every value AND type from the ai-assert barrel, including
// its side-effecting matcher/real-seam registrations, so `@nanobpm/urban-testkit/ai`
// stays byte-for-byte the surface it published before the lift.
export * from "@nanobpm/ai-assert";
