// Fluent text-assertion entry + matcher-registration seam (issue #297, slice S1).
//
// `assertThatText(actual)` returns a `TextAssertion` whose methods DISPATCH through a
// registry. S2 registers `matchesSemantically` and S3 registers `satisfiesJudge` from
// their own files via `registerTextMatcher` — neither edits this file nor the other's.
// Calling a matcher that no one has registered throws a clear "not installed" error.

import type { JudgeOptions, SemanticSimilarityConfig } from "./config.ts";

/** The fluent assertion surface. Both methods are installed via the registry. */
export interface TextAssertion {
  matchesSemantically(expected: string, options?: SemanticSimilarityConfig): Promise<void>;
  satisfiesJudge(criteria: string, options?: JudgeOptions): Promise<void>;
}

/**
 * A registered matcher handler. Receives the `actual` text and the positional arguments
 * of the fluent method (`[expected, options]` for `matchesSemantically`,
 * `[criteria, options]` for `satisfiesJudge`). Handlers narrow the args at runtime.
 */
export type TextMatcher = (actual: string, args: readonly unknown[]) => Promise<void>;

/** An isolated registry instance (used directly in tests for isolation). */
export interface TextMatcherRegistry {
  register(name: string, handler: TextMatcher): void;
  has(name: string): boolean;
  assertThatText(actual: string): TextAssertion;
}

/** Creates a fresh, isolated matcher registry. */
export function createTextMatcherRegistry(): TextMatcherRegistry {
  const matchers = new Map<string, TextMatcher>();

  const dispatch = (name: string, actual: string, args: readonly unknown[]): Promise<void> => {
    const handler = matchers.get(name);
    if (handler === undefined) {
      throw new Error(
        `text matcher "${name}" is not installed — import the module that registers it`,
      );
    }
    return handler(actual, args);
  };

  return {
    register(name, handler) {
      matchers.set(name, handler);
    },
    has(name) {
      return matchers.has(name);
    },
    assertThatText(actual) {
      return {
        matchesSemantically: async (expected, options) =>
          dispatch("matchesSemantically", actual, [expected, options]),
        satisfiesJudge: async (criteria, options) =>
          dispatch("satisfiesJudge", actual, [criteria, options]),
      };
    },
  };
}

const defaultRegistry = createTextMatcherRegistry();

/** Registers a matcher on the default registry (called by S2/S3 at import). */
export function registerTextMatcher(name: string, handler: TextMatcher): void {
  defaultRegistry.register(name, handler);
}

/** The public fluent entry point, dispatching through the default registry. */
export function assertThatText(actual: string): TextAssertion {
  return defaultRegistry.assertThatText(actual);
}
