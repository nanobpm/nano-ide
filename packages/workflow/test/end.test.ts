// Unit tests for `w.end()` — ending a path early (a BPMN none end event) or the
// whole instance (`{ terminate: true }`, a terminate end event). No gateway needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { defineFlow, declarativeToBpmn } from "../dist/index.js";

const noop = async () => ({});

/** Every `<bpmn:endEvent>` in the model: its id, incoming flow ids, and whether it terminates. */
function endEvents(xml: string): { id: string; incoming: string[]; terminate: boolean }[] {
  return [...xml.matchAll(/<bpmn:endEvent id="([^"]+)">([\s\S]*?)<\/bpmn:endEvent>/g)].map((m) => ({
    id: m[1],
    incoming: [...m[2].matchAll(/<bpmn:incoming>([^<]+)<\/bpmn:incoming>/g)].map((i) => i[1]),
    terminate: m[2].includes("<bpmn:terminateEventDefinition"),
  }));
}

/** Sequence flows as `source->target`. */
function flows(xml: string): string[] {
  return [...xml.matchAll(/<bpmn:sequenceFlow id="[^"]+" sourceRef="([^"]+)" targetRef="([^"]+)"/g)].map((m) => `${m[1]}->${m[2]}`);
}

test("end: a branch ends early; the other path still reaches the final End", () => {
  const xml = declarativeToBpmn(
    defineFlow("early", (w) => {
      w.run("check", noop);
      w.branch("abandon = true", { then: (b) => b.run("close", noop).end("abandoned") });
      w.run("merge", noop);
    }),
  );
  const ends = endEvents(xml);
  assert.deepEqual(
    ends.map((e) => [e.id, e.incoming.length, e.terminate]).sort(),
    [
      ["End", 1, false],
      ["abandoned", 1, false],
    ],
  );
  assert.ok(flows(xml).includes("close->abandoned"));
  // `merge` is reached only from the gateway's else path, not from the ended branch.
  assert.equal(flows(xml).filter((f) => f.endsWith("->merge")).length, 1);
});

test("end: { terminate: true } renders a terminate end event", () => {
  const xml = declarativeToBpmn(
    defineFlow("term", (w) => {
      w.switch("decision", {
        stop: (b) => b.end("stopped", { terminate: true }),
        default: (b) => b.run("go", noop),
      });
    }),
  );
  const stopped = endEvents(xml).find((e) => e.id === "stopped");
  assert.ok(stopped?.terminate, "stopped is a terminate end event");
  assert.match(xml, /<bpmn:endEvent id="stopped">\s*<bpmn:incoming>[^<]+<\/bpmn:incoming>\s*<bpmn:terminateEventDefinition \/>\s*<\/bpmn:endEvent>/);
});

test("end: when every path ends early there is no dangling final End", () => {
  const xml = declarativeToBpmn(
    defineFlow("all-end", (w) => {
      w.switch("x", {
        a: (b) => b.end("a-done"),
        default: (b) => b.end({ terminate: true }),
      });
    }),
  );
  const ends = endEvents(xml);
  assert.equal(ends.find((e) => e.id === "End"), undefined, "no unconnected final End");
  assert.equal(ends.length, 2);
  for (const e of ends) assert.equal(e.incoming.length, 1, `${e.id} has its incoming flow`);
  assert.ok(ends.some((e) => /^End_\d+$/.test(e.id) && e.terminate), "an unnamed end gets a generated End_<n> id");
});

test("end: unnamed ends get distinct ids", () => {
  const xml = declarativeToBpmn(
    defineFlow("anon", (w) => {
      w.switch("x", { a: (b) => b.end(), b: (b) => b.end(), default: (b) => b.run("c", noop) });
    }),
  );
  const ids = endEvents(xml).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id.startsWith("End_")).length, 2);
});

test("end: inside a loop it leaves the loop and the flow; the loop still loops", () => {
  const xml = declarativeToBpmn(
    defineFlow("loop-end", (w) => {
      w.loop((b) => {
        b.run("poll", noop);
        b.switch("state", {
          landed: (c) => c.end("landed"),
          evicted: (c) => c.end("evicted", { terminate: true }),
          default: (c) => c.run("wait", noop),
        });
      });
    }),
  );
  const ends = endEvents(xml);
  assert.deepEqual(ends.map((e) => e.id).sort(), ["evicted", "landed"]);
  assert.ok(flows(xml).some((f) => f.startsWith("wait->")), "the default path loops back");
});

test("end: inside a forEach body it ends that item's child; the sub-process end is skipped when nothing reaches it", () => {
  const xml = declarativeToBpmn(
    defineFlow("each-end", (w) => {
      w.forEach("items", "item", (b) => {
        b.run("look", noop);
        b.end("item-done");
      });
      w.run("after", noop);
    }),
  );
  assert.doesNotMatch(xml, /Sub_\d+_end/, "no unconnected sub-process end");
  assert.match(xml, /<bpmn:subProcess[\s\S]*<bpmn:endEvent id="item-done">[\s\S]*<\/bpmn:subProcess>/);
  assert.ok(flows(xml).some((f) => f.endsWith("->after")), "the flow continues after the forEach");
});

test("end: nothing may follow it in the same block", () => {
  assert.throws(
    () =>
      declarativeToBpmn(
        defineFlow("after-end", (w) => {
          w.run("a", noop);
          w.end("done");
          w.run("b", noop);
        }),
      ),
    /nothing can follow end\(\)/,
  );
});

test("end: a plain end in a parallel branch is rejected (the join would wait forever); terminate is allowed", () => {
  assert.throws(
    () =>
      defineFlow("par", (w) => {
        w.parallel([(b) => b.run("l", noop), (b) => b.branch("bad = true", { then: (c) => c.end("oops") })]);
      }),
    /a branch can't end\(\) on its own/,
  );
  const xml = declarativeToBpmn(
    defineFlow("par-term", (w) => {
      w.parallel([(b) => b.run("l", noop), (b) => b.branch("bad = true", { then: (c) => c.end("stop", { terminate: true }) })]);
      w.run("after", noop);
    }),
  );
  assert.ok(endEvents(xml).find((e) => e.id === "stop")?.terminate);
  // A plain end inside a forEach inside a parallel branch ends the item's child, not the branch.
  assert.doesNotThrow(() =>
    defineFlow("par-each", (w) => {
      w.parallel([
        (b) => b.run("l", noop),
        (b) => b.forEach("xs", "x", (c) => c.run("r", noop).end("x-done")),
      ]);
    }),
  );
});

test("end: names are claimed like step names; End_ is reserved for generated ids; options are validated", () => {
  assert.throws(() => defineFlow("dup", (w) => w.run("done", noop).end("done")), /done/);
  assert.throws(() => defineFlow("res", (w) => w.run("End_1", noop)), /reserved prefix/);
  // @ts-expect-error terminate must be a boolean
  assert.throws(() => defineFlow("opt", (w) => w.end("x", { terminate: "yes" })), /terminate/);
});

test("end: a step after a block whose paths all end is unreachable", () => {
  assert.throws(
    () =>
      declarativeToBpmn(
        defineFlow("all-arms-end", (w) => {
          w.switch("x", { a: (b) => b.end("a"), default: (b) => b.end("d") });
          w.run("after", noop);
        }),
      ),
    /"run" step after a "switch" step whose paths all end is unreachable/,
  );
});

test("end: in a parallel branch, a non-interrupting boundary's timeout body may end; an always-terminating branch is rejected", () => {
  assert.doesNotThrow(() =>
    declarativeToBpmn(
      defineFlow("par-nudge", (w) => {
        w.parallel([
          (b) => b.run("l", noop),
          (b) => b.run("slow", noop).boundary({ timer: "PT1H", interrupting: false, onTimeout: (c) => c.run("nudge", noop).end("nudge-done") }),
        ]);
        w.run("after", noop);
      }),
    ),
  );
  assert.throws(
    () =>
      defineFlow("par-int", (w) => {
        w.parallel([
          (b) => b.run("l", noop),
          (b) => b.run("slow", noop).boundary({ timer: "PT1H", onTimeout: (c) => c.end("gave-up") }),
        ]);
      }),
    /a branch can't end\(\) on its own/,
  );
  assert.throws(
    () =>
      declarativeToBpmn(
        defineFlow("par-always", (w) => {
          w.parallel([(b) => b.run("fast", noop), (b) => b.timer("slow", { after: "PT1M" }).end("stop", { terminate: true })]);
          w.run("after", noop);
        }),
      ),
    /never reaches the join/,
  );
});
