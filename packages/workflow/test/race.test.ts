// Unit + derivation-parity tests for `w.race` (the event-based gateway, epic
// #314, S1/#316). These need no gateway and always run against the built `dist`.
//
// The parity assertion validates that `w.race` derives an event-based gateway
// STRUCTURALLY IDENTICAL to convergence-loop's `gw-review-wait` for the same arms.
// It uses the S0 harness `normalize` (@nanobpm/workflow/test-support) to reduce
// both the derived flow and the vendored golden to their semantic model, then
// compares the event-based-gateway REGION (the gateway's fork degree + each fork
// target's event-definition kind and wiring). A full-model `assertDerivationParity`
// against convergence-loop.bpmn is deliberately NOT used here: that model also
// needs `w.human` (S3) and the linked-resource binding (S4) and carries
// hand-authored message names / ioMappings, so reproducing it verbatim is the S5
// PORT's job — S1 owns only the race mechanism, asserted at region granularity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, declarativeToBpmn, walkNodes } from "../dist/index.js";
import { normalize, type CanonicalModel } from "../dist/test-support/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVERGENCE_GOLDEN = join(HERE, "fixtures", "nwf", "convergence-loop.bpmn");

/** The structural signature of a model's single event-based-gateway region: the
 *  gateway's (in,out) fork degree, and — per fork — the target catch event's
 *  event-definition kind and (in,out) degree. Id-, name-, and label-agnostic, so
 *  it captures the RACE SHAPE while tolerating the model-specific message name /
 *  ioMapping the golden carries (an S5 port concern, not an S1 one). */
interface RaceRegion {
  gateway: { in: number; out: number };
  arms: { event: "message" | "timer"; in: number; out: number }[];
}

function degree(label: string): { in: number; out: number } {
  const m = label.match(/<in=(\d+),out=(\d+)/);
  if (!m) throw new Error(`no degree signature in node label: ${label}`);
  return { in: Number(m[1]), out: Number(m[2]) };
}

function raceRegion(model: CanonicalModel): RaceRegion {
  // Fork flows leave the event-based gateway UNCONDITIONALLY (` =[]=> `) for an
  // intermediate catch event — the only legal target of an event-based gateway.
  const forks = model.flows.filter((f) => /^eventBasedGateway.* =\[\]=> intermediateCatchEvent/.test(f));
  if (forks.length === 0) throw new Error("no event-based-gateway fork flows found");
  const gateway = degree(forks[0].slice(0, forks[0].indexOf(" =[]=> ")));
  const arms = forks
    .map((f) => {
      const target = f.slice(f.indexOf(" =[]=> ") + " =[]=> ".length);
      const event: "message" | "timer" = /messageEventDefinition/.test(target)
        ? "message"
        : /timerEventDefinition/.test(target)
          ? "timer"
          : (() => {
              throw new Error(`catch event has neither a message nor a timer definition: ${target}`);
            })();
      const d = degree(target);
      return { event, in: d.in, out: d.out };
    })
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  return { gateway, arms };
}

/** Every message subscription's FEEL correlation-key expression (e.g. `=prKey`),
 *  sorted. */
function correlationKeys(model: CanonicalModel): string[] {
  return model.messages
    .map((m) => m.match(/correlationKey=(=[^}]+)}/)?.[1])
    .filter((k): k is string => typeof k === "string")
    .sort();
}

test("race derives an event-based gateway structurally identical to convergence-loop's gw-review-wait (parity harness)", () => {
  // The same two arms gw-review-wait uses: a review-ready MESSAGE catch correlated
  // on prKey, racing a review-timeout TIMER catch.
  const flow = defineFlow("race-parity", (w) => {
    w.run("review-round", async () => ({}));
    w.race({
      "wait-review": { signal: { correlationKey: "prKey" }, do: (b) => b.run("re-review", async () => ({})) },
      "wait-review-timeout": { timer: { after: "=reviewWaitTimeout" }, do: (b) => b.run("escalate", async () => ({})) },
    });
    w.run("finalize", async () => ({}));
  });

  const golden = normalize(readFileSync(CONVERGENCE_GOLDEN, "utf8"));
  const derived = normalize(declarativeToBpmn(flow));

  assert.deepEqual(
    raceRegion(derived),
    raceRegion(golden),
    "derived event-based gateway region must match convergence-loop's gw-review-wait",
  );
  // The message arm derives the same correlation key the golden subscribes on.
  assert.ok(correlationKeys(golden).includes("=prKey"), "golden subscribes review-ready on =prKey");
  assert.ok(correlationKeys(derived).includes("=prKey"), "derived race signal arm subscribes on =prKey");
});

test("race emits one event-based-gateway fork per arm, each to an intermediate catch event", () => {
  const flow = defineFlow("race-fork", (w) => {
    w.race({
      a: { signal: { correlationKey: "k" }, do: () => {} },
      b: { timer: { after: "PT5M" }, do: () => {} },
      c: { timer: { at: "2027-01-01T00:00:00Z" }, do: () => {} },
    });
  });
  const xml = declarativeToBpmn(flow);
  const gw = xml.match(/<bpmn:eventBasedGateway id="(Gw_\d+)">([\s\S]*?)<\/bpmn:eventBasedGateway>/);
  assert.ok(gw, "an eventBasedGateway is emitted");
  const outgoing = [...gw[2].matchAll(/<bpmn:outgoing>/g)];
  assert.equal(outgoing.length, 3, "one outgoing fork per arm");
  // Every fork targets an intermediate catch event (BPMN event-based gateway rule).
  const catches = [...xml.matchAll(/<bpmn:intermediateCatchEvent id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(catches.sort(), ["a", "b", "c"], "each arm becomes an intermediate catch event named for the arm");
});

test("race signal arm emits a message catch and lifts a correlated <bpmn:message>", () => {
  const flow = defineFlow("race-signal", (w) => {
    w.race({
      approved: { signal: { correlationKey: "userId" }, do: (b) => b.run("provision", async () => ({})) },
      lapsed: { timer: { after: "=slaTimeout" }, do: (b) => b.run("expire", async () => ({})) },
    });
  });
  const xml = declarativeToBpmn(flow);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="approved"[\s\S]*?<bpmn:messageEventDefinition messageRef="Msg_approved" \/>/);
  assert.match(xml, /<bpmn:message id="Msg_approved" name="race-signal:approved">/);
  assert.match(xml, /<zeebe:subscription correlationKey="=userId" \/>/);
});

test("race signal arm trims { correlationKey } before validating/emitting (timer-arm parity)", () => {
  // A correlationKey with stray surrounding whitespace is usable once trimmed, so
  // it must NOT fail the NCName check and must emit the trimmed identifier — in
  // parity with how the timer arm trims { after }/{ at } before validation.
  const flow = defineFlow("race-signal-trim", (w) => {
    w.race({
      approved: { signal: { correlationKey: "  prKey  " }, do: (b) => b.run("provision", async () => ({})) },
      lapsed: { timer: { after: "=slaTimeout" }, do: (b) => b.run("expire", async () => ({})) },
    });
  });
  const xml = declarativeToBpmn(flow);
  assert.match(xml, /<zeebe:subscription correlationKey="=prKey" \/>/);
  assert.doesNotMatch(xml, /correlationKey="=\s|correlationKey="=prKey\s/);
});

test("race timer arm emits a timer catch: { after } → timeDuration, { at } → timeDate", () => {
  const flow = defineFlow("race-timer", (w) => {
    w.race({
      soon: { timer: { after: "PT30S" }, do: () => {} },
      atNoon: { timer: { at: "2027-06-01T12:00:00Z" }, do: () => {} },
    });
  });
  const xml = declarativeToBpmn(flow);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="soon"[\s\S]*?<bpmn:timerEventDefinition>[\s\S]*?<bpmn:timeDuration>PT30S<\/bpmn:timeDuration>/);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="atNoon"[\s\S]*?<bpmn:timerEventDefinition>[\s\S]*?<bpmn:timeDate>2027-06-01T12:00:00Z<\/bpmn:timeDate>/);
});

test("race timer arm accepts a FEEL-expression duration", () => {
  const flow = defineFlow("race-feel", (w) => {
    w.race({
      ready: { signal: { correlationKey: "k" }, do: () => {} },
      timeout: { timer: { after: "=reviewWaitTimeout" }, do: () => {} },
    });
  });
  assert.match(declarativeToBpmn(flow), /<bpmn:timeDuration>=reviewWaitTimeout<\/bpmn:timeDuration>/);
});

test("race arm bodies converge on the node that follows the race", () => {
  const flow = defineFlow("race-converge", (w) => {
    w.race({
      win: { signal: { correlationKey: "k" }, do: (b) => b.run("onWin", async () => ({})) },
      lose: { timer: { after: "PT1M" }, do: (b) => b.run("onLose", async () => ({})) },
    });
    w.run("after", async () => ({}));
  });
  const xml = declarativeToBpmn(flow);
  // Both arm bodies' tails flow into the same following activity (an implicit XOR
  // merge): `after` has two incoming flows, one per arm.
  const after = xml.match(/<bpmn:serviceTask id="after"[\s\S]*?<\/bpmn:serviceTask>/);
  assert.ok(after, "the following activity is emitted");
  assert.equal([...after[0].matchAll(/<bpmn:incoming>/g)].length, 2, "the race's two arms converge on the next node");
});

test("race signal arm is discoverable by walkNodes (so the message emitter and client.signal see it)", () => {
  const flow = defineFlow("race-walk", (w) => {
    w.race({
      inner: { signal: { correlationKey: "k" }, do: (b) => b.run("body-task", async () => ({})) },
      timer: { timer: { after: "PT1M" }, do: () => {} },
    });
  });
  const kinds: string[] = [];
  const names: string[] = [];
  walkNodes(flow.steps, (n) => {
    kinds.push(n.kind);
    if (n.kind === "signal") names.push(n.name);
  });
  assert.ok(kinds.includes("race"), "the race node itself is visited");
  assert.ok(kinds.includes("signal"), "the nested signal arm is recursed into");
  assert.deepEqual(names, ["inner"], "the race signal arm is reachable to client.signal / the message emitter");
});

test("race rejects a degenerate gateway (fewer than two arms)", () => {
  assert.throws(
    () => defineFlow("bad", (w) => w.race({ only: { signal: { correlationKey: "k" }, do: () => {} } })),
    /at least two arms/,
  );
});

test("race rejects an arm that is neither a signal nor a timer, or both", () => {
  assert.throws(
    () => defineFlow("bad", (w) => w.race({ a: { do: () => {} }, b: { timer: { after: "PT1M" }, do: () => {} } })),
    /exactly one of/,
  );
  assert.throws(
    () =>
      defineFlow("bad", (w) =>
        w.race({
          a: { signal: { correlationKey: "k" }, timer: { after: "PT1M" }, do: () => {} },
          b: { timer: { after: "PT1M" }, do: () => {} },
        }),
      ),
    /exactly one of/,
  );
});

test("race rejects an arm missing its do block", () => {
  assert.throws(
    () =>
      defineFlow("bad", (w) =>
        w.race({ a: { signal: { correlationKey: "k" } }, b: { timer: { after: "PT1M" }, do: () => {} } }),
      ),
    /needs a do block/,
  );
});

test("race rejects a timer arm with both { after } and { at } (or neither)", () => {
  assert.throws(
    () =>
      defineFlow("bad", (w) =>
        w.race({
          a: { timer: { after: "PT1M", at: "2027-01-01T00:00:00Z" }, do: () => {} },
          b: { signal: { correlationKey: "k" }, do: () => {} },
        }),
      ),
    /exactly one of \{ after \}/,
  );
});

test("race rejects a runtime-invalid timer arm with a non-string { after } instead of throwing a TypeError", () => {
  // A runtime-invalid arm supplies BOTH keys where only `at` is a string. The
  // exactly-one check must reject on KEY PRESENCE — not silently dispatch into
  // `after.trim()` and blow up with an opaque `TypeError: after.trim is not a
  // function`. Built via JSON.parse so the input is genuinely `any` at runtime
  // (no `as` cast), then the non-serializable `do` blocks are attached.
  const bothKeys = JSON.parse(
    '{"a":{"timer":{"after":1,"at":"2027-01-01T00:00:00Z"}},"b":{"signal":{"correlationKey":"k"}}}',
  );
  bothKeys.a.do = () => {};
  bothKeys.b.do = () => {};
  assert.throws(() => defineFlow("bad", (w) => w.race(bothKeys)), /exactly one of \{ after \}/);

  // Only a non-string `after` present: must reject with a clear validation error,
  // not a TypeError from calling `.trim()` on a number.
  const nonStringAfter = JSON.parse('{"a":{"timer":{"after":1}},"b":{"signal":{"correlationKey":"k"}}}');
  nonStringAfter.a.do = () => {};
  nonStringAfter.b.do = () => {};
  assert.throws(() => defineFlow("bad", (w) => w.race(nonStringAfter)), /timer \{ after \} must be a string/);
});
