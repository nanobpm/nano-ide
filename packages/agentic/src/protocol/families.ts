/**
 * Canonical message-family set for the Nano agentic protocol.
 *
 * This is the single source of truth every family module keys off — S1's
 * `registerFamilyHandler(family, handler)` seam, the frame codec, and each
 * per-family module all derive their family key from {@link MESSAGE_FAMILIES}.
 * Do not fork this list; extend it here.
 *
 * Directions (informational — the codec is direction-agnostic):
 *  - `register` / `heartbeat` / `deregister` — worker → hub (presence)
 *  - `serve`                                 — hub → worker (assigned tokens)
 *  - `demand`                                — hub → observers (demand×supply)
 *  - `blackboard`                            — both directions (coordination)
 *  - `relay`                                 — both directions (terminal bytes)
 *  - `claim` / `release`                     — worker → hub (job ownership)
 */
export const MESSAGE_FAMILIES = [
  "register",
  "heartbeat",
  "deregister",
  "serve",
  "demand",
  "blackboard",
  "relay",
  "claim",
  "release",
] as const;

export type MessageFamily = (typeof MESSAGE_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(MESSAGE_FAMILIES);

export function isMessageFamily(value: unknown): value is MessageFamily {
  return typeof value === "string" && FAMILY_SET.has(value);
}

/**
 * Stable on-wire codes for each family. Codes are part of the wire contract and
 * MUST NOT be renumbered; only append new families with new, unused codes.
 */
export const FAMILY_CODES = {
  register: 1,
  heartbeat: 2,
  deregister: 3,
  serve: 4,
  demand: 5,
  blackboard: 6,
  relay: 7,
  claim: 8,
  release: 9,
} as const satisfies Record<MessageFamily, number>;

const CODE_TO_FAMILY: ReadonlyMap<number, MessageFamily> = new Map(
  MESSAGE_FAMILIES.map((family) => [FAMILY_CODES[family], family]),
);

export function familyForCode(code: number): MessageFamily | undefined {
  return CODE_TO_FAMILY.get(code);
}
