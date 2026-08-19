// Cosine similarity — the single canonical implementation for the S2 matcher (issue #297).
//
// Pure and dependency-free so it can be unit-tested in isolation from the embedding seam.

/**
 * Cosine similarity of two equal-length numeric vectors, in `[-1, 1]` (in `[0, 1]` for the
 * non-negative bag-of-tokens vectors the fake embedding produces). A zero-magnitude vector
 * has no direction, so similarity against it is defined as `0`.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity requires equal-length vectors (got ${a.length} and ${b.length})`,
    );
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index];
    const y = b[index];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
