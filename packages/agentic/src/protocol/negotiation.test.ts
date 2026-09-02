import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_ADVERTISEMENT,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  negotiate,
  parseAdvertisement,
  type ProtocolAdvertisement,
} from "./negotiation.ts";

// An OLD peer predates the appended claim/release families and the named
// features — it advertises only the original seven families.
const OLD_PEER: ProtocolAdvertisement = {
  version: 1,
  families: ["register", "heartbeat", "deregister", "serve", "demand", "blackboard", "relay"],
  features: [],
};

test("new local negotiating against an old peer degrades to the shared subset", () => {
  const shared = negotiate(LOCAL_ADVERTISEMENT, OLD_PEER);
  // The appended ownership families are NOT sent to a peer that can't decode them.
  assert.equal(shared.supportsFamily("claim"), false);
  assert.equal(shared.supportsFamily("release"), false);
  // The original families remain available.
  assert.equal(shared.supportsFamily("register"), true);
  assert.equal(shared.supportsFamily("relay"), true);
  // Features nobody-both-implements are off.
  assert.equal(shared.supportsFeature("claim-release"), false);
  assert.equal(shared.supportsFeature("multi-instance"), false);
});

test("old local negotiating against a new peer also degrades to the shared subset", () => {
  const shared = negotiate(OLD_PEER, LOCAL_ADVERTISEMENT);
  assert.equal(shared.supportsFamily("claim"), false);
  assert.equal(shared.supportsFamily("register"), true);
  assert.deepEqual([...shared.features].sort(), []);
});

test("two new peers negotiate the full family + feature set", () => {
  const shared = negotiate(LOCAL_ADVERTISEMENT, LOCAL_ADVERTISEMENT);
  assert.equal(shared.supportsFamily("claim"), true);
  assert.equal(shared.supportsFamily("release"), true);
  for (const feature of PROTOCOL_FEATURES) {
    assert.equal(shared.supportsFeature(feature), true, feature);
  }
  assert.equal(shared.version, PROTOCOL_VERSION);
});

test("negotiation never throws on a raw/garbage remote advertisement", () => {
  // A future peer advertising an unknown family + feature: unknown entries are
  // dropped, known ones kept — no protocol error.
  const future = { version: 99, families: ["register", "claim", "teleport"], features: ["multi-instance", "warp"] };
  const shared = negotiate(LOCAL_ADVERTISEMENT, future);
  assert.equal(shared.supportsFamily("claim"), true);
  assert.equal(shared.supportsFamily("register"), true);
  assert.equal(shared.supportsFeature("multi-instance"), true);
  // Version negotiates DOWN to this build's own.
  assert.equal(shared.version, PROTOCOL_VERSION);

  // Wholly malformed shapes degrade to an empty support set rather than throwing.
  for (const junk of [null, undefined, 42, "nope", [], { families: "no" }]) {
    const s = negotiate(LOCAL_ADVERTISEMENT, junk);
    assert.equal(s.families.size, 0, JSON.stringify(junk));
    assert.equal(s.features.size, 0, JSON.stringify(junk));
    assert.equal(s.version, 0, JSON.stringify(junk));
  }
});

test("parseAdvertisement keeps only known families/features and clamps a bad version to 0", () => {
  const parsed = parseAdvertisement({
    version: -3,
    families: ["register", "claim", "bogus", 7],
    features: ["claim-release", "unknown"],
  });
  assert.deepEqual(parsed.families, ["register", "claim"]);
  assert.deepEqual(parsed.features, ["claim-release"]);
  assert.equal(parsed.version, 0);
});
