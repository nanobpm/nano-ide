// Compile-time regression guard for the defineFlow typing surface.
//
// This file is NOT a `*.test.ts` (so `node --test` ignores it); it is checked by
// `tsc -p tsconfig.types.json` (see the package `typecheck` script). It must
// COMPILE. If it stops compiling, a typing regression has been introduced.
//
// Regression it guards (the bug fixed alongside this file): the UNTYPED
// `defineFlow(id, build)` overload used to default the builder to
// `Record<string, never>`, which made `keyof C` === `string` and collapsed every
// step's `job.variables` to `never` and every handler return to `void` — so no
// untyped flow that RETURNS DATA could compile (including the README's own
// examples). The builder's untyped default is now `object`, so every step falls
// back to `JsonObject`.

import { defineFlow, envelope } from "../src/index.js";
import type { HumanIoMapping } from "../src/index.js";

// (A) Untyped flow whose handlers RETURN DATA — the exact shape that regressed.
//     Under the old `Record<string, never>` default this failed with
//     "'{ userId: string; }' is not assignable to 'void'".
export const onboarding = defineFlow("onboarding", (w) => {
  w.run("createAccount", async () => ({ userId: "u1" }));
  w.signal("approved", { correlationKey: "userId" });
  w.run("provision", async () => ({ ok: true }));
  w.run("audit", async (job) => ({ seen: job.variables })); // untyped vars = JsonObject
});

// (B) Typed-contracts flow — `job.variables` and the return value are typed from
//     the step's `in`/`out` envelopes. This must keep compiling: the fix loosens
//     only the UNTYPED builder default, not the typed contract resolution.
const ChargeIn = envelope("ChargeIn", { orderId: "string", total: "number" });
const ChargeOut = envelope("ChargeOut", { ok: "boolean" });

export const orders = defineFlow(
  "orders",
  { charge: { in: ChargeIn, out: ChargeOut } },
  (w) =>
    w.run("charge", async (job) => {
      const total: number = job.variables.total; // typed from ChargeIn
      return { ok: total > 0 }; // typed ChargeOut
    }),
);

// (C) Parallelism primitives — `parallel` fans out concurrent branches, `forEach`
//     fans out over a FEEL collection. Inside their blocks the builder is the
//     SAME typed builder, so contract typing still flows through.
export const fanout = defineFlow(
  "fanout",
  { charge: { in: ChargeIn, out: ChargeOut } },
  (w) => {
    w.parallel([
      (b) => b.task("audit"),
      (b) =>
        b.run("charge", async (job) => {
          const total: number = job.variables.total; // typed inside a parallel branch
          return { ok: total > 0 };
        }),
    ]);
    w.forEach("items", "item", (b) => b.task("handle"), {
      outputCollection: "results",
      outputElement: "handle.out",
      sequential: false,
    });
  },
);

// (D) Service-task io mappings — `w.task` / `w.run` accept an optional `{ io }`
//     using the SHARED HumanIoMapping shape (issue #405). This must compile: the
//     option is optional, reuses `{ input?, output? }` of `{ source, target }`
//     entries, and combines with an external `task`'s `jobType`/`prompt`.
const conformanceIo: HumanIoMapping = {
  input: [{ source: "=planKey", target: "planKey" }],
  output: [{ source: "=ack", target: "ack" }],
};

export const serviceIo = defineFlow("service-io", (w) => {
  w.task("record-conformance-ack", { jobType: "pr.conformance-ack", io: conformanceIo });
  w.task("agent", {
    jobType: "senior:x",
    prompt: { resourceId: "x.md", append: "=ctx" },
    io: { input: [{ source: "=planKey", target: "planKey" }] },
  });
  w.run("compute", async () => ({ n: 1 }), { io: { output: [{ source: "=n", target: "n" }] } });
});
