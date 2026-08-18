// Composable text preprocessors (issue #297, slice S1).

import type { TextPreprocessor, TextPreprocessors } from "./config.ts";

/** Lowercases the input. */
export const lowercase: TextPreprocessor = (input) => input.toLowerCase();

/** Trims leading/trailing whitespace and collapses internal runs to a single space. */
export const trim: TextPreprocessor = (input) => input.trim().replace(/\s+/g, " ");

/** Strips punctuation (keeps Unicode letters, numbers and whitespace). */
export const stripPunctuation: TextPreprocessor = (input) =>
  input.replace(/[^\p{L}\p{N}\s]/gu, "");

/**
 * Composes an ordered list of preprocessors into a single transform applied
 * left-to-right. An empty list is the identity transform.
 */
export function composePreprocessors(preprocessors: TextPreprocessors): TextPreprocessor {
  return (input) => preprocessors.reduce((value, transform) => transform(value), input);
}
