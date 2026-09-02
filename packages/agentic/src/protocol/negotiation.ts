/**
 * Additive capability/version negotiation for the agentic wire protocol.
 *
 * The frame codec is append-only (families/codes MUST NOT be renumbered), but an
 * OLD peer that never learned a newly-appended family (e.g. `claim`/`release`,
 * codes 8/9) rejects it as an `unknown-family` decode error. Negotiation exists
 * so a NEW peer never *sends* a family the far end can't decode: each side
 * advertises the families + named features it supports, and both derive the
 * SHARED subset. A new supervisor against an old hub, and an old supervisor
 * against a new hub, both degrade to the intersection — never a protocol error.
 *
 * Negotiation is intentionally forgiving of the remote advertisement: unknown
 * family names / feature strings / a missing or malformed field are dropped, not
 * rejected, so a peer from a FUTURE protocol revision (advertising families this
 * build has never heard of) still negotiates cleanly down to the shared subset.
 */
import { MESSAGE_FAMILIES, isMessageFamily, type MessageFamily } from "./families.ts";

/**
 * The wire-protocol revision. Bumped only for a change that is not expressible
 * as a purely additive family/feature (which negotiation already handles). Two
 * peers negotiate down to `min(local, remote)`.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Named, negotiable capabilities layered on top of the raw family set. A family
 * code answers "can you decode this frame?"; a feature answers "do you implement
 * this behaviour?". `claim-release` gates the ownership frames; `multi-instance`
 * gates multiplexing N workers over one connection.
 */
export const PROTOCOL_FEATURES = ["claim-release", "multi-instance"] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];

const FEATURE_SET: ReadonlySet<string> = new Set(PROTOCOL_FEATURES);

/** What a peer tells the other side it supports, exchanged at the handshake. */
export interface ProtocolAdvertisement {
  readonly version: number;
  readonly families: readonly MessageFamily[];
  readonly features: readonly ProtocolFeature[];
}

/** This build's own advertisement — every family and feature it implements. */
export const LOCAL_ADVERTISEMENT: ProtocolAdvertisement = {
  version: PROTOCOL_VERSION,
  families: MESSAGE_FAMILIES,
  features: PROTOCOL_FEATURES,
};

/** The shared protocol two peers agreed on: the intersection of their supports. */
export interface NegotiatedProtocol {
  /** The lower of the two advertised versions. */
  readonly version: number;
  /** Families BOTH peers can decode — the only ones safe to send. */
  readonly families: ReadonlySet<MessageFamily>;
  /** Features BOTH peers implement. */
  readonly features: ReadonlySet<ProtocolFeature>;
  /** Whether it is safe to send `family` to the far end. */
  supportsFamily(family: MessageFamily): boolean;
  /** Whether both peers implement `feature`. */
  supportsFeature(feature: ProtocolFeature): boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a peer's (untrusted, possibly future/garbage) advertisement into a known
 * one, keeping only the families/features this build recognises. A missing or
 * malformed `version` degrades to 0 (older-than-anything), which negotiates the
 * result down to this build's own version. This never throws — an unparseable
 * advertisement simply yields an empty support set.
 */
export function parseAdvertisement(value: unknown): ProtocolAdvertisement {
  if (!isPlainObject(value)) {
    return { version: 0, families: [], features: [] };
  }
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0
      ? value.version
      : 0;
  const rawFamilies = Array.isArray(value.families) ? value.families : [];
  const families = rawFamilies.filter(isMessageFamily);
  const rawFeatures = Array.isArray(value.features) ? value.features : [];
  const features = rawFeatures.filter((f): f is ProtocolFeature => typeof f === "string" && FEATURE_SET.has(f));
  return { version, families, features };
}

/**
 * Negotiate the shared protocol from two advertisements. `remote` may be a raw,
 * untrusted value straight off the wire — it is run through
 * {@link parseAdvertisement} first, so unknown families/features and malformed
 * shapes are dropped rather than raising. The result is the intersection: the
 * only families safe to send and the features both sides implement.
 */
export function negotiate(
  local: ProtocolAdvertisement,
  remote: ProtocolAdvertisement | unknown,
): NegotiatedProtocol {
  const parsedRemote = parseAdvertisement(remote);
  const remoteFamilies = new Set<MessageFamily>(parsedRemote.families);
  const remoteFeatures = new Set<ProtocolFeature>(parsedRemote.features);

  const families = new Set<MessageFamily>(local.families.filter((f) => remoteFamilies.has(f)));
  const features = new Set<ProtocolFeature>(local.features.filter((f) => remoteFeatures.has(f)));
  const version = Math.min(local.version, parsedRemote.version);

  return {
    version,
    families,
    features,
    supportsFamily: (family) => families.has(family),
    supportsFeature: (feature) => features.has(feature),
  };
}
