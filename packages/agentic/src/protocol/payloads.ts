import { isMessageFamily, type MessageFamily } from "./families.ts";
import { isValidToken } from "./token.ts";

/**
 * Minimal per-family payload contract. This is the wire-level shape every
 * family module (S1 hub, S2 presence, S3 vocab, S5 relay, S7 blackboard) builds
 * on — the single source of truth for the payload of each message family, held
 * to by both this repo's codec and the c8ctl client.
 *
 * Validators are STRUCTURAL and forward-compatible: they require the core
 * fields with correct types and otherwise tolerate additional properties, so a
 * later slice may enrich a payload without breaking older peers.
 *
 * Capability (cognition/weight/family/host) travels on `register` as an
 * enrolment attribute — it is NEVER a routing token.
 */
export interface Capability {
  readonly cognition?: string;
  readonly weight?: number;
  readonly family?: string;
  readonly host?: string;
}

export interface RegisterPayload {
  readonly instance: string;
  readonly capability: Capability;
}

export interface HeartbeatPayload {
  readonly instance: string;
}

export interface DeregisterPayload {
  readonly instance: string;
  readonly reason?: string;
}

export interface ServePayload {
  readonly instance: string;
  readonly tokens: readonly string[];
}

export interface DemandPayload {
  readonly network: string;
  readonly missing: readonly string[];
}

export type BlackboardOp = "append" | "read";

export interface BlackboardPayload {
  readonly op: BlackboardOp;
  readonly dedupeKey?: string;
  readonly since?: number;
}

/**
 * The `relay` family multiplexes two roles on one message family:
 *
 *  - CONTROL frames a peer sends the hub: a producer's {@link RelayProducePayload}
 *    (`op: "produce"`), and a consumer's {@link RelaySubscribePayload} /
 *    {@link RelayCreditPayload}.
 *  - DELIVERY frames the hub sends a consumer: a data chunk ({@link RelayPayload},
 *    no `op`) and a resume ack ({@link RelaySubscribedPayload}, `op: "subscribed"`).
 *
 * {@link RelayPayload} is the DELIVERY data chunk specifically (`{ stream, offset,
 * chunk }`, no `op`) — the hub assigns the authoritative `offset` from its ring.
 * A producer must NOT send this shape; it sends {@link RelayProducePayload}.
 */
export interface RelayPayload {
  readonly stream: string;
  readonly offset: number;
  readonly chunk: string;
}

/** A producer appends bytes to a stream. `incarnation` is the producer's
 * generation, stamped so the hub can fence a stale predecessor (a retried job on
 * a fresh runner takes over with a strictly higher incarnation). The hub assigns
 * the offset — a producer never carries one. */
export interface RelayProducePayload {
  readonly op: "produce";
  readonly stream: string;
  readonly incarnation: number;
  readonly chunk: string;
}

/** A consumer subscribes to a stream, optionally resuming from `from` with an
 * initial `credit` budget. */
export interface RelaySubscribePayload {
  readonly op: "subscribe";
  readonly stream: string;
  readonly from?: number;
  readonly credit?: number;
}

/** A consumer replenishes its flow-control budget. */
export interface RelayCreditPayload {
  readonly op: "credit";
  readonly credit: number;
}

/** The hub's ack to a subscribe: `gap` is true when `from` predated the retained
 * ring (bytes were missed), `nextOffset` is where delivery resumes. */
export interface RelaySubscribedPayload {
  readonly op: "subscribed";
  readonly stream: string;
  readonly gap: boolean;
  readonly nextOffset: number;
}

export interface PayloadError {
  readonly code: string;
  readonly message: string;
}

export type PayloadValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly PayloadError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateRegister(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.instance)) {
    errors.push({ code: "bad-instance", message: "register.instance must be a non-empty string" });
  }
  if (!isPlainObject(p.capability)) {
    errors.push({ code: "bad-capability", message: "register.capability must be an object" });
    return;
  }
  const cap = p.capability;
  for (const field of ["cognition", "family", "host"] as const) {
    if (field in cap && typeof cap[field] !== "string") {
      errors.push({ code: "bad-capability", message: `register.capability.${field} must be a string when present` });
    }
  }
  if ("weight" in cap && typeof cap.weight !== "number") {
    errors.push({ code: "bad-capability", message: "register.capability.weight must be a number when present" });
  }
}

function validateInstanceOnly(family: string, p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.instance)) {
    errors.push({ code: "bad-instance", message: `${family}.instance must be a non-empty string` });
  }
}

function validateDeregister(p: Record<string, unknown>, errors: PayloadError[]): void {
  validateInstanceOnly("deregister", p, errors);
  if ("reason" in p && typeof p.reason !== "string") {
    errors.push({ code: "bad-reason", message: "deregister.reason must be a string when present" });
  }
}

function validateServe(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.instance)) {
    errors.push({ code: "bad-instance", message: "serve.instance must be a non-empty string" });
  }
  const tokens = p.tokens;
  if (!Array.isArray(tokens)) {
    errors.push({ code: "bad-tokens", message: "serve.tokens must be an array" });
    return;
  }
  tokens.forEach((token, index) => {
    if (typeof token !== "string" || !isValidToken(token)) {
      errors.push({ code: "bad-token", message: `serve.tokens[${index}] is not a valid routing token` });
    }
  });
}

function validateDemand(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.network)) {
    errors.push({ code: "bad-network", message: "demand.network must be a non-empty string" });
  }
  const missing = p.missing;
  if (!Array.isArray(missing) || !missing.every((entry) => typeof entry === "string")) {
    errors.push({ code: "bad-missing", message: "demand.missing must be an array of strings" });
  }
}

function validateBlackboard(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (p.op !== "append" && p.op !== "read") {
    errors.push({ code: "bad-op", message: "blackboard.op must be 'append' or 'read'" });
  }
  if ("dedupeKey" in p && typeof p.dedupeKey !== "string") {
    errors.push({ code: "bad-dedupe-key", message: "blackboard.dedupeKey must be a string when present" });
  }
  if ("since" in p && (typeof p.since !== "number" || !Number.isInteger(p.since) || p.since < 0)) {
    errors.push({ code: "bad-since", message: "blackboard.since must be a non-negative integer when present" });
  }
  if ("files" in p && (!Array.isArray(p.files) || !p.files.every((f) => typeof f === "string"))) {
    errors.push({ code: "bad-files", message: "blackboard.files must be an array of strings when present" });
  }
}

function validateRelay(p: Record<string, unknown>, errors: PayloadError[]): void {
  const op = p.op;
  // No `op`: a DELIVERY data chunk (hub -> consumer) — `{ stream, offset, chunk }`.
  if (op === undefined) {
    if (!nonEmptyString(p.stream)) {
      errors.push({ code: "bad-stream", message: "relay.stream must be a non-empty string" });
    }
    if (!nonNegInt(p.offset)) {
      errors.push({ code: "bad-offset", message: "relay.offset must be a non-negative integer" });
    }
    if (typeof p.chunk !== "string") {
      errors.push({ code: "bad-chunk", message: "relay.chunk must be a string" });
    }
    return;
  }
  // Otherwise an op-tagged CONTROL/ack frame.
  switch (op) {
    case "produce":
      if (!nonEmptyString(p.stream)) {
        errors.push({ code: "bad-stream", message: "relay.produce.stream must be a non-empty string" });
      }
      if (!nonNegInt(p.incarnation)) {
        errors.push({ code: "bad-incarnation", message: "relay.produce.incarnation must be a non-negative integer" });
      }
      if (typeof p.chunk !== "string") {
        errors.push({ code: "bad-chunk", message: "relay.produce.chunk must be a string" });
      }
      return;
    case "subscribe":
      if (!nonEmptyString(p.stream)) {
        errors.push({ code: "bad-stream", message: "relay.subscribe.stream must be a non-empty string" });
      }
      if ("from" in p && !nonNegInt(p.from)) {
        errors.push({ code: "bad-from", message: "relay.subscribe.from must be a non-negative integer when present" });
      }
      if ("credit" in p && !nonNegInt(p.credit)) {
        errors.push({ code: "bad-credit", message: "relay.subscribe.credit must be a non-negative integer when present" });
      }
      return;
    case "credit":
      if (!nonNegInt(p.credit)) {
        errors.push({ code: "bad-credit", message: "relay.credit.credit must be a non-negative integer" });
      }
      return;
    case "subscribed":
      if (!nonEmptyString(p.stream)) {
        errors.push({ code: "bad-stream", message: "relay.subscribed.stream must be a non-empty string" });
      }
      if (typeof p.gap !== "boolean") {
        errors.push({ code: "bad-gap", message: "relay.subscribed.gap must be a boolean" });
      }
      if (!nonNegInt(p.nextOffset)) {
        errors.push({ code: "bad-next-offset", message: "relay.subscribed.nextOffset must be a non-negative integer" });
      }
      return;
    default:
      errors.push({
        code: "bad-op",
        message: `relay.op must be one of produce|subscribe|credit|subscribed, got ${String(op)}`,
      });
  }
}

/**
 * Validate a decoded payload against its family's minimal contract.
 */
export function validatePayload(family: MessageFamily, payload: unknown): PayloadValidationResult {
  if (!isMessageFamily(family)) {
    return { ok: false, errors: [{ code: "unknown-family", message: `unknown family: ${String(family)}` }] };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ code: "not-object", message: `${family} payload must be an object` }] };
  }

  const errors: PayloadError[] = [];
  switch (family) {
    case "register":
      validateRegister(payload, errors);
      break;
    case "heartbeat":
      validateInstanceOnly("heartbeat", payload, errors);
      break;
    case "deregister":
      validateDeregister(payload, errors);
      break;
    case "serve":
      validateServe(payload, errors);
      break;
    case "demand":
      validateDemand(payload, errors);
      break;
    case "blackboard":
      validateBlackboard(payload, errors);
      break;
    case "relay":
      validateRelay(payload, errors);
      break;
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
