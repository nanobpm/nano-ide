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

export interface RelayPayload {
  readonly stream: string;
  readonly offset: number;
  readonly chunk: string;
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

function validateRegister(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.instance)) {
    errors.push({ code: "bad-instance", message: "register.instance must be a non-empty string" });
  }
  if (!isPlainObject(p.capability)) {
    errors.push({ code: "bad-capability", message: "register.capability must be an object" });
  }
}

function validateInstanceOnly(family: string, p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.instance)) {
    errors.push({ code: "bad-instance", message: `${family}.instance must be a non-empty string` });
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
}

function validateRelay(p: Record<string, unknown>, errors: PayloadError[]): void {
  if (!nonEmptyString(p.stream)) {
    errors.push({ code: "bad-stream", message: "relay.stream must be a non-empty string" });
  }
  if (typeof p.offset !== "number" || !Number.isInteger(p.offset) || p.offset < 0) {
    errors.push({ code: "bad-offset", message: "relay.offset must be a non-negative integer" });
  }
  if (typeof p.chunk !== "string") {
    errors.push({ code: "bad-chunk", message: "relay.chunk must be a string" });
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
      validateInstanceOnly("deregister", payload, errors);
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
