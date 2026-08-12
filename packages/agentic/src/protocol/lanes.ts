/**
 * The three QoS lanes carried on the one agentic channel, in STRICT priority
 * order: control/facts > interactive > bulk.
 *
 * The ordering is the contract: a bulk-output storm (relay chunks) must never
 * head-of-line-block a heartbeat or a blackboard write. The scheduler that
 * enforces this lives in S5; this module owns the canonical lane set, their
 * wire codes, and the priority comparison every scheduler derives from.
 */
export const QOS_LANES = ["control", "interactive", "bulk"] as const;

export type QosLane = (typeof QOS_LANES)[number];

const LANE_SET: ReadonlySet<string> = new Set(QOS_LANES);

export function isQosLane(value: unknown): value is QosLane {
  return typeof value === "string" && LANE_SET.has(value);
}

/**
 * On-wire lane codes. The numeric value is also the priority rank: a LOWER
 * code is HIGHER priority (control=0 outranks bulk=2). Do not renumber.
 */
export const LANE_CODES = {
  control: 0,
  interactive: 1,
  bulk: 2,
} as const satisfies Record<QosLane, number>;

const CODE_TO_LANE: ReadonlyMap<number, QosLane> = new Map(
  QOS_LANES.map((lane) => [LANE_CODES[lane], lane]),
);

export function laneForCode(code: number): QosLane | undefined {
  return CODE_TO_LANE.get(code);
}

/** Priority rank of a lane; lower is dispatched first. */
export function lanePriority(lane: QosLane): number {
  return LANE_CODES[lane];
}

/**
 * Canonical scheduler ordering derived from the lane priorities: control before
 * interactive before bulk, ties broken by ascending `seq` so a single lane
 * drains in emission order. Returns <0 when `a` should be dispatched before `b`.
 */
export function compareFrameOrder(
  a: { readonly lane: QosLane; readonly seq: number },
  b: { readonly lane: QosLane; readonly seq: number },
): number {
  const byLane = lanePriority(a.lane) - lanePriority(b.lane);
  return byLane !== 0 ? byLane : a.seq - b.seq;
}
