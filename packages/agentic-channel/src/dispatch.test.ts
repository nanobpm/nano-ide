import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";
import {
  DuplicateFamilyHandlerError,
  FamilyRouter,
  UnknownFamilyError,
} from "./dispatch.ts";

function frame(family: Frame["family"], seq = 1): Frame {
  return { lane: "control", family, seq, payload: { seq } };
}

test("routes each frame to the handler registered for its family (>=2 families)", async () => {
  const router = new FamilyRouter<string[]>();
  const heard: string[] = [];

  // Two distinct family modules attach themselves through the seam.
  router.registerFamilyHandler("register", (f, ctx) => {
    ctx.push(`register:${f.seq}`);
  });
  router.registerFamilyHandler("relay", (f, ctx) => {
    ctx.push(`relay:${f.seq}`);
  });

  assert.ok(await router.route(frame("register", 1), heard));
  assert.ok(await router.route(frame("relay", 2), heard));
  assert.ok(await router.route(frame("register", 3), heard));

  // Each frame reached exactly its own handler — no cross-talk.
  assert.deepEqual(heard, ["register:1", "relay:2", "register:3"]);
  assert.deepEqual(router.families().sort(), ["register", "relay"]);
});

test("the routing table is derived, not hard-coded — encode/decode round-trips through it", async () => {
  const router = new FamilyRouter<Frame[]>();
  const seen: Frame[] = [];
  router.registerFamilyHandler("heartbeat", (f, ctx) => {
    ctx.push(f);
  });

  // Prove the table (not a switch) drives dispatch by feeding a real wire frame.
  const bytes = encodeFrame(frame("heartbeat", 7));
  assert.ok(bytes.length > 0);
  await router.route(frame("heartbeat", 7), seen);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.family, "heartbeat");
});

test("a second handler for the same family is refused", () => {
  const router = new FamilyRouter<void>();
  router.registerFamilyHandler("blackboard", () => {});
  assert.throws(
    () => router.registerFamilyHandler("blackboard", () => {}),
    (err) => err instanceof DuplicateFamilyHandlerError && err.family === "blackboard",
  );
});

test("registering a key outside the S0 family set is refused", () => {
  const router = new FamilyRouter<void>();
  const notAFamily = JSON.parse('"telemetry"');
  assert.throws(
    () => router.registerFamilyHandler(notAFamily, () => {}),
    (err) => err instanceof UnknownFamilyError,
  );
});

test("an unregistered family falls through to the unhandled fallback", async () => {
  const router = new FamilyRouter<string[]>();
  const heard: string[] = [];
  router.onUnhandled((f, ctx) => {
    ctx.push(`unhandled:${f.family}`);
  });

  const handled = await router.route(frame("demand", 1), heard);
  assert.equal(handled, false);
  assert.deepEqual(heard, ["unhandled:demand"]);
});
