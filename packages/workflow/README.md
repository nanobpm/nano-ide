# @nanobpm/workflow

Code-first durable orchestration for [nanobpmn](https://nanobpm.io)
(**ADR 0044**). Author durable workflows as ordinary async code; the SDK derives
the executable BPMN model, the job types, and the message/correlation wiring, and
hosts a generic worker. No diagram, no task-type wiring, no correlation plumbing
written by hand.

It talks to a **running nanobpmn gateway** over the REST v2 API — the engine
provides the durability (crash-resume, at-least-once jobs, message correlation);
this package is a thin authoring + runtime layer on top.

## Why

Nano already *is* a durable-execution substrate: the raft journal is the event
history, the engine is itself replay-from-journal, a job+worker is an activity, a
message is a signal, a BPMN timer is a timer. The missing piece was never
durability — it was **authoring ergonomics**. This package removes the ceremony
(model a diagram → wire each task to a job type → wire payloads → register
workers) that Temporal and Camunda both impose.

## Install

```sh
npm install @nanobpm/workflow
```

Requires Node ≥ 20 and a reachable nanobpmn gateway (default `http://localhost:8080`).

## Two authoring surfaces

Both compile to the same engine durability; pick per workflow.

### Declarative (with control flow, human-in-the-loop signals, and typed I/O)

**The recommended surface.** Describe the flow as a **tree of nodes**: `w.run` (a
locally-hosted service task), `w.task` (an external-worker service task — job
type `${flowId}:${name}` by default, or pass `w.task(name, { jobType })` to
target an existing worker pool, e.g. a `senior:pr-review` agent token),
`w.signal` (a durable message catch that resumes via a correlated message — the
human-in-the-loop path), and `w.human` (a BPMN **user task** — a human-in-the-loop
approval gate rendered on a task list), composed with control-flow combinators:

- `w.switch(subject, cases)` — a multi-way exclusive choice; each case key routes
  when `subject = value`; an optional `default` case is the fallback.
- `w.branch(condition, { then, else? })` — a two-way choice on a FEEL boolean.
- `w.human(name, { form, assignee?, candidateGroups?, io? })` — a durable **user
  task** (`<bpmn:userTask>` with the Zeebe user-task marker). `form` binds a
  `zeebe:formDefinition` (the form id shown to the assignee). Add an assignment
  with `assignee` (a static user id or a FEEL expression like
  `=escalationAssignee`) and/or `candidateGroups` (who may claim it) — supply
  either or both. `io` adds a `zeebe:ioMapping` of `{ input?, output? }` entries
  (`{ source, target }`: a FEEL `source` copied to/from the process variable
  `target`), e.g. to stamp the reviewer's decision back onto a variable on
  completion. The token waits durably until the task is completed from a task
  list / the Zeebe user-task API.
- `w.loop(body)` — a durable loop (back-edge to the loop head).
- `w.break()` / `w.continue()` — exit the enclosing loop, or jump back to its head.
- `w.parallel([blockA, blockB, …])` — a static fork/join: every block runs
  concurrently on its own branch, rejoined by an AND-join (all branches must
  arrive before the flow continues).
- `w.forEach(collection, itemVar, body, opts?)` — a data-driven fan-out over a
  FEEL `collection`: one child instance of `body` runs per item (the item bound to
  `itemVar`). `{ sequential }` runs children one at a time; `{ outputCollection,
  outputElement }` collects each child's result into a list; `{ completionCondition }`
  completes the body early.
- `w.race({ armName: { signal | timer, do }, … })` — a first-of race over ≥2
  named arms, each waiting on **exactly one** event: a `signal` (a correlated
  message catch, `{ correlationKey }`) or a `timer` (`{ after }` for a duration or
  `{ at }` for a date, ISO or a leading-`=` FEEL expression). Whichever arm's event
  fires **first wins**: its `do` block runs and the losers are cancelled. Compiles
  to an **event-based gateway** fanning out to one intermediate catch event per arm
  (a message- or timer-event-definition), the arm bodies rejoining downstream by an
  implicit XOR merge. This is the shape a convergence loop uses to bound a
  human-in-the-loop wait with a timeout.
- `w.run(...).boundary({ timer, onTimeout, interrupting?, name? })` — attach an
  SLA (an interrupting timer boundary event) to the PRECEDING activity: when
  `timer` elapses the activity is cancelled and the token routes to the
  `onTimeout` escalation body, which then converges with the activity's normal
  continuation. `timer` is an ISO-8601 duration (`PT24H`) or a FEEL
  `=`-expression (`=escalationSlaTimeout`). `interrupting` defaults to `true`
  (pass `false` for a non-interrupting boundary that leaves the activity running).

```ts
import { defineFlow, WorkflowClient, Worker } from "@nanobpm/workflow";

const onboarding = defineFlow("onboarding", (w) => {
  w.run("createAccount", async (job) => ({ userId: makeId() }));
  w.signal("approved", { correlationKey: "userId" });
  w.run("provision", async (job) => ({ ok: true }));
});

const client = new WorkflowClient({ baseUrl: "http://localhost:8080" });
await client.deploy(onboarding);
new Worker({ baseUrl: "http://localhost:8080", workflows: [onboarding] }).start();

const { processInstanceKey } = await client.start(onboarding, {});
// ... later, when a human approves:
await client.signal(onboarding, "approved", userId, { by: "alice" });
```

A human-in-the-loop **approval gate** with a form, an assignment, and an output
mapping that stamps the decision back onto a process variable:

```ts
const review = defineFlow("plan-review", (w) => {
  w.human("plan-review-decision", {
    form: "plan-review-decision",         // zeebe:formDefinition formId
    assignee: "=escalationAssignee",       // a FEEL expression (or a static user id)
    candidateGroups: "operators",          // who may claim it
    io: { output: [{ source: "=verdict", target: "planVerdict" }] },
  });
  w.switch("planVerdict", {
    approve: (c) => c.run("apply", applyPlan),
    default: (c) => c.run("revise", revisePlan),
  });
});
```


A durable convergence loop (the shape `urban-pr-review` uses) — a loop wrapping a
status switch with a nested guard:

```ts
const convergence = defineFlow("convergence-loop", (w) => {
  w.loop((b) => {
    b.run("review-round", async (job) => ({ status: classify(job.variables) }));
    b.switch("status", {
      converged: (c) => { c.run("persist-converged", finalize); c.break(); },
      addressed: (c) => c.branch("round >= maxRounds", {
        then: (g) => { g.run("persist-escalation", persist);
                       g.signal("wait-answer", { correlationKey: "prKey" }); },
        else: (g) => { g.run("persist-round", persist);   // returns { round: round + 1 }
                       g.signal("wait-review", { correlationKey: "prKey" }); },
      }),
      default: (c) => { c.run("persist-blocked", persist);
                        c.signal("wait-input", { correlationKey: "prKey" }); },
    });
  });
});
```

Bound a human-in-the-loop wait with a timeout — `w.race` resolves to whichever
arm fires first, cancelling the loser:

```ts
const reviewWait = defineFlow("review-wait", (w) => {
  w.run("request-review", async (job) => ({ prKey: job.variables.prKey }));
  w.race({
    "review-arrived": {
      signal: { correlationKey: "prKey" },
      do: (b) => b.run("apply-review", applyReview),
    },
    "review-timed-out": {
      timer: { after: "=reviewWaitTimeout" }, // FEEL duration, e.g. "PT48H"
      do: (b) => b.run("escalate", escalate),
    },
  });
  w.run("finalize", finalize);
});
```

`switch` /
`branch` → an exclusive gateway (in-order conditions, first match wins, default =
unconditional flow); `loop` → a convergent gateway whose body falls through back to
the head; nodes with multiple incoming flows are an implicit XOR merge; `parallel`
→ a diverging/converging **parallel gateway** pair (AND fork/join); `forEach` → a
**parallel multi-instance** activity (a single-step body) or an embedded
multi-instance sub-process (a multi-step body); `race` → an **event-based
gateway** fanning out to one intermediate catch event per arm (message or timer),
first event wins and cancels the losers. See **ADR 0047**.

#### Typed data envelopes (eject to model-first with contracts intact)

Declare typed payload contracts in code with `envelope(name, fields)`, then pass a
**contracts map keyed by step name** as `defineFlow`'s second argument. The step
name auto-types the handler's `job.variables` (from `in`) and its return (from
`out`), and the envelopes are **lifted into the emitted model** as `nano:shape` +
`io.nanobpm.dataEnvelope.*` — the exact carrier the Fused Domain Model (ADR 0040)
derives worker I/O from. So the generated `.bpmn` is ejectable to the modeller with
its typed contracts intact — no cliff between code-first and model-first.

```ts
import { defineFlow, envelope } from "@nanobpm/workflow";

const ChargeIn  = envelope("ChargeIn",  { orderId: "string", total: "number" });
const ChargeOut = envelope("ChargeOut", { ok: "boolean" });

const orders = defineFlow(
  "orders",
  { charge: { in: ChargeIn, out: ChargeOut } },
  (w) => w.run("charge", async (job) => {
    // job.variables is typed { orderId: string; total: number }
    return { ok: await gateway.charge(job.variables) };  // typed ChargeOut
  }),
);
```

#### Agent tasks — bind an LLM prompt to a worker (`w.task(name, { prompt })`)

An **agent service task** is a `w.task` that additionally binds an LLM **prompt
resource** to the worker that services it. Pass a `prompt` alongside the
`jobType` capability token and the emitter adds a
`<zeebe:linkedResource … resourceType="GenericScript" linkName="prompt">` to the
task's `zeebe:taskDefinition` — the shape the nano-workforce agent tasks use to
attach a prompt script to the (e.g. `senior:retro`) agent pool that runs the job:

```ts
w.task("synthesize", {
  jobType: "senior:retro",              // the agent capability token
  prompt: {
    resourceId: "retro.md",             // the GenericScript resource bound as the prompt
    bindingType: "latest",              // optional — how the version resolves (default "latest")
    append: "=retroDigest",             // optional — FEEL fed to a zeebe:ioMapping `appendPrompt` input
  },
});
```

derives:

```xml
<bpmn:serviceTask id="synthesize" name="synthesize">
  <bpmn:extensionElements>
    <zeebe:taskDefinition type="senior:retro" />
    <zeebe:linkedResources>
      <zeebe:linkedResource resourceId="retro.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" />
    </zeebe:linkedResources>
    <zeebe:ioMapping>
      <zeebe:input source="=retroDigest" target="appendPrompt" />
    </zeebe:ioMapping>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

Only `resourceId` is required; omit `append` and no `ioMapping` is emitted. A
`w.task` **without** a `prompt` is unchanged — it emits no `linkedResources`.
Data envelopes (via contracts) still lift alongside the prompt binding.

#### Service-task I/O mappings (`w.task`/`w.run` with `{ io }`)

Any service task — external (`w.task`) or locally-hosted (`w.run`) — can carry a
general `<zeebe:ioMapping>` of arbitrary **input** (applied on activation) and
**output** (applied on completion) variable mappings via an optional `io`. It
reuses the same `{ input?, output? }` shape as `w.human`'s `io` (a single
`HumanIoMapping` / `HumanIoEntry`, no parallel type):

```ts
w.task("record-conformance-ack", {
  jobType: "pr.conformance-ack",
  io: {
    input: [
      { source: "=planKey", target: "planKey" },
      { source: "=if (is defined(note)) then note else null", target: "note" },
    ],
  },
});
```

derives:

```xml
<bpmn:serviceTask id="record-conformance-ack" name="record-conformance-ack">
  <bpmn:extensionElements>
    <zeebe:taskDefinition type="pr.conformance-ack" />
    <zeebe:ioMapping>
      <zeebe:input source="=planKey" target="planKey" />
      <zeebe:input source="=if (is defined(note)) then note else null" target="note" />
    </zeebe:ioMapping>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

The `ioMapping` is emitted after `taskDefinition` (and after `linkedResources` /
envelope `properties` when present). When a task has **both** a `prompt.append`
and an explicit `io.input`, they merge into a **single** `<zeebe:ioMapping>` (the
`appendPrompt` input trails the explicit inputs) — never two. Omit `io` (or pass
an empty `{}`) and no `ioMapping` is emitted.

### Imperative (Temporal-style, engine-replayed) — experimental/internal

Write the orchestration as a function. `ctx.run(name, fn)` is a durable step: its
result is journalled in an engine process variable, so on resume a completed step
is **replayed from the journal** (its side effect is **not** re-run) and only the
frontier step executes. The engine drives the function by re-invoking a single
looped orchestrator job each turn.

> This surface is **experimental/internal** — the declarative `defineFlow` above is
> the one true code-first surface (ADR 0044 update, 2026-07-30). The replay
> machinery is retained as the seed for a future code-block-in-a-node escape hatch.

```ts
import { defineWorkflow, WorkflowClient, Worker } from "@nanobpm/workflow";

const prReview = defineWorkflow("pr-review", async (ctx) => {
  const diff = await ctx.run("fetchDiff", () => gh.diff(ctx.input.prId));
  const review = await ctx.run("review", () => llm.review(diff));
  await ctx.run("merge", () => gh.merge(ctx.input.prId));
});

const client = new WorkflowClient({ baseUrl: "http://localhost:8080" });
await client.deploy(prReview);

const worker = new Worker({ baseUrl: "http://localhost:8080", workflows: [prReview] });
worker.start();

await client.start(prReview, { prId: "PR-1234" });
```

If the engine crashes after `review` commits and restarts cold, `fetchDiff` and
`review` are **not** re-run — the workflow resumes at `merge`, which runs exactly
once.

## Honest scope

- **Durability is the engine's**, via leader-durable replication (ADR 0003). On a
  single node it survives process crash / SIGKILL / OOM; on a cluster it is
  majority-durable and survives node loss.
- **Jobs are at-least-once.** A step's side effect runs *before* the job
  completes; a crash in between causes redelivery and a repeat. **Handlers must be
  idempotent.** For the imperative surface, `ctx.run` de-dupes *within* a workflow
  (the journal), not across an external side effect that already partially applied.
- **The determinism constraint binds only the imperative orchestration
  function**, not the activities. Do all non-deterministic / side-effecting work
  inside `ctx.run(name, fn)` closures — never in the orchestration body directly.
- **Never swallow `ctx.run`'s suspension.** The imperative surface advances one
  step per turn by *throwing* out of the orchestration body after the frontier
  step. Do not wrap the orchestration body in a broad `try/catch` that catches
  everything — catching that internal suspension breaks replay (multiple steps
  could run in one turn, or the workflow could hang). Keep `try/catch` *inside*
  individual `ctx.run(name, fn)` closures instead.
- **The worker uses a single `baseUrl`.** For the single-user SDLC use case this
  is fine; it is a client SPOF (no worker-side failover), not an engine limit.

## API

| Export | Purpose |
| --- | --- |
| `defineWorkflow(id, orchFn)` | Imperative (replayed) workflow — experimental/internal. |
| `defineFlow(id, [contracts,] build)` | Declarative flow: `run`/`task`/`signal`/`timer` + `switch`/`branch`/`loop`/`break`/`continue` + `parallel`/`forEach`, with an optional typed contracts map. |
| `envelope(name, fields)` | A typed data envelope; lifted into the model as a `nano:shape` + `dataEnvelope` wiring. |
| `externalJobTypes(flow)` | The job types of a flow's external `task` steps (each overridable per-step via `w.task(name, { jobType })`). |
| `WorkflowClient` | `deploy`, `start`, `signal`, `getInstance` over REST v2. |
| `Worker` | Generic job runtime; routes job types → handlers, hosts the replay loop. |
| `toBpmn(workflow)` | The DI-less semantic BPMN the engine runs (for inspection / deployment). |
| `toDeployableBpmn(workflow, { layout? })` | The deployable BPMN **with an auto-generated diagram (DI)** so the deployed model is inspectable; what `deploy` sends by default. |
| `layoutBpmn(xml)` / `declarativeToLayoutedBpmn(flow)` | Add DI to a model with `bpmn-auto-layout`. |

### Inspectable deployments (diagram layout)

`client.deploy(flow)` deploys the model **with an auto-generated diagram
interchange (DI)** so it opens rendered and inspectable in a modeller/Operate
rather than as a blank canvas. DI is generated with the optional peer dependency
[`bpmn-auto-layout`](https://www.npmjs.com/package/bpmn-auto-layout):

```sh
npm i bpmn-auto-layout
```

If it is not installed, `deploy` degrades gracefully — it warns once and deploys
the DI-less model. Pass `deploy(flow, { layout: false })` to skip layout
deliberately. The semantic model stays authoritative; DI is derived and
regenerable.

See [ADR 0044](../docs/adr/0044-code-first-durable-orchestration.md) for the design
rationale and [ADR 0047](../docs/adr/0047-declarative-flow-control-and-typed-envelopes.md)
for the control-flow combinators and typed data envelopes.

## Development

```sh
npm ci
npm run build        # tsc → dist/ (committed)
npm run typecheck
npm test             # build + unit tests; integration tests self-skip without a gateway binary
```

The integration tests boot a real gateway from the sibling `server/` build if
present (`server/target/debug/nanobpm-gateway-rest-server`); otherwise they skip.

## License

Apache-2.0.
