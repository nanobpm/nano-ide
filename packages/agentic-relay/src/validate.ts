/**
 * Canonical safe-integer validators for the relay package.
 *
 * Every integer the relay handles — replay offsets, ring/bulk capacities,
 * credit budgets, incarnation generations, and untrusted inbound protocol
 * fields (`from`, `credit`, `incarnation`) — is accumulated, decremented,
 * compared, or round-tripped through JSON. A value beyond
 * `Number.MAX_SAFE_INTEGER` cannot survive that arithmetic or JSON round-trip
 * without silent precision loss, which would corrupt offset/credit semantics.
 * `Number.isSafeInteger` (not `Number.isInteger`) is therefore the single
 * correct predicate. Deriving every integer check from these two guards keeps
 * that rule in one place instead of scattering `Number.isInteger(x) || x < 0`
 * across the package, where one site could drift from the rest.
 */

/** A non-negative safe integer: `0, 1, … Number.MAX_SAFE_INTEGER`. */
export function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A positive safe integer: `1, 2, … Number.MAX_SAFE_INTEGER`. */
export function isPosInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
