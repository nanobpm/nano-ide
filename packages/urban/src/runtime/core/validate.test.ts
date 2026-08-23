import { test } from "node:test";
import assert from "node:assert/strict";
import { collectManifestIssues, validateManifest, ManifestValidationError } from "./validate.ts";
import { BIND_MODES } from "./manifest.ts";

const valid = {
  schemaVersion: 1,
  id: "nano-workforce",
  name: "Nano Workforce",
  data: { default: "app", sources: { app: { driver: "sqlite", url: "file:./x.db" } } },
  types: { task: { table: "crew_tasks", fields: { title: { type: "string" } } } },
  workers: [{ taskType: "a.b", handler: "workers/x.ts" }],
  triggers: [{ id: "t", type: "webhook", path: "/h" }],
};

test("a well-formed manifest has no issues", () => {
  assert.deepEqual(collectManifestIssues(valid), []);
  assert.equal(validateManifest(valid).id, "nano-workforce");
});

test("missing required keys are reported (driven by the schema)", () => {
  const issues = collectManifestIssues({ schemaVersion: 1 });
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("id"));
  assert.ok(paths.includes("name"));
});

test("unknown top-level keys are rejected (additionalProperties:false)", () => {
  const issues = collectManifestIssues({ ...valid, bogus: 1 });
  assert.ok(issues.some((i) => i.path === "bogus"));
});

test("an `actions` array is an accepted top-level key (ADR 0055 §3)", () => {
  const issues = collectManifestIssues({
    ...valid,
    actions: [{ path: "/app/actions/cancel", module: "actions/cancel.ts" }],
  });
  assert.deepEqual(issues, []);
});

test("a `ui` block is an accepted top-level key (Studio App View, ADR 0057 / nano-bpm #638)", () => {
  const issues = collectManifestIssues({
    ...valid,
    ui: { enabled: true, portEnv: "PORT", path: "/", label: "Nano Workforce" },
  });
  assert.deepEqual(issues, []);
});

// Drift guard: the validator's accepted set is derived from `BIND_MODES` (via `isBindMode`),
// so every declared mode must validate. If the validator ever re-hardcodes a divergent literal
// set, or a mode is added to `BIND_MODES` without the validator following, this fails.
test("a `network` block with a valid bind is accepted for every BIND_MODES value (issue #235)", () => {
  for (const bind of BIND_MODES) {
    assert.deepEqual(collectManifestIssues({ ...valid, network: { bind } }), []);
  }
  assert.deepEqual(collectManifestIssues({ ...valid, network: {} }), []);
});

test("a `network.bind` outside loopback|all is reported (issue #235)", () => {
  const issues = collectManifestIssues({ ...valid, network: { bind: "lan" } });
  assert.ok(issues.some((i) => i.path === "network.bind"));
});

test("a non-object `network` is reported (issue #235)", () => {
  const issues = collectManifestIssues({ ...valid, network: "all" });
  assert.ok(issues.some((i) => i.path === "network"));
});

test("an unknown key inside `network` is rejected (network additionalProperties:false, issue #235)", () => {
  const issues = collectManifestIssues({ ...valid, network: { bind: "loopback", binn: "all" } });
  assert.ok(issues.some((i) => i.path === "network.binn"));
  // A valid `bind` alongside the typo must not itself be flagged.
  assert.ok(!issues.some((i) => i.path === "network.bind"));
});

test("bad schemaVersion and bad slug id are reported", () => {
  const issues = collectManifestIssues({ ...valid, schemaVersion: 2, id: "Not A Slug" });
  assert.ok(issues.some((i) => i.path === "schemaVersion"));
  assert.ok(issues.some((i) => i.path === "id"));
});

test("binding rules: worker needs handler-or-llm, source needs driver+url", () => {
  const issues = collectManifestIssues({
    ...valid,
    workers: [{ taskType: "a" }],
    types: { t: { fields: { x: { type: "string" } } } },
    data: { default: "app", sources: { app: { driver: "sqlite" } } },
  });
  assert.ok(issues.some((i) => i.path === "workers[0]" && /handler.*llm/.test(i.message)));
  // A type with `fields` and no `table` is a valid transient type — no issue.
  assert.ok(!issues.some((i) => i.path.startsWith("types.t")));
  assert.ok(issues.some((i) => i.path === "data.sources.app.url"));
});

test("an llm-backed worker (no handler) is accepted", () => {
  const issues = collectManifestIssues({
    ...valid,
    workers: [{ taskType: "summarize", llm: "gpt" }],
  });
  assert.ok(!issues.some((i) => i.path.startsWith("workers[0]")));
});

test("data.default must reference an existing source", () => {
  const issues = collectManifestIssues({
    ...valid,
    data: { default: "nope", sources: { app: { driver: "sqlite", url: "file:./x" } } },
  });
  assert.ok(issues.some((i) => i.path === "data.default"));
});

test("a worker connection must reference a declared connections entry", () => {
  const missing = collectManifestIssues({
    ...valid,
    workers: [{ taskType: "a.b", connector: "slack", connection: "slack" }],
  });
  assert.ok(missing.some((i) => i.path === "workers[0].connection"));

  const present = collectManifestIssues({
    ...valid,
    workers: [{ taskType: "a.b", connector: "slack", connection: "slack" }],
    connections: { slack: { type: "slack" } },
  });
  assert.ok(!present.some((i) => i.path === "workers[0].connection"));
});

test("a non-object connections does not throw and flags the reference", () => {
  const issues = collectManifestIssues({
    ...valid,
    workers: [{ taskType: "a.b", connector: "slack", connection: "slack" }],
    connections: "nope",
  });
  assert.ok(issues.some((i) => i.path === "workers[0].connection"));
});

test("validateManifest throws ManifestValidationError with issues", () => {
  assert.throws(() => validateManifest({ schemaVersion: 1 }), (e: unknown) => {
    assert.ok(e instanceof ManifestValidationError);
    assert.ok(e.issues.length >= 2);
    return true;
  });
});

test("a well-formed instanceTracking binding has no issues", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["planning"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("an instanceTracking binding missing table/keyField/onTerminated.set is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [{ onTerminated: { set: {} } }],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].table"));
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].keyField"));
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].onTerminated.set"));
});

test("an instanceTracking binding with a well-formed onWaitingHuman.set has no issues", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        terminalStatuses: ["abandoned"],
        onTerminated: { set: { status: "abandoned" } },
        onWaitingHuman: { set: { status: "awaiting_operator" } },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("an instanceTracking onWaitingHuman with an empty set patch is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        onTerminated: { set: { status: "abandoned" } },
        onWaitingHuman: { set: {} },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].onWaitingHuman.set"));
});

test("an instanceTracking binding omitting onWaitingHuman is valid (the edge is opt-in)", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("instanceTracking activeStatuses without statusField is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        activeStatuses: ["planning"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].activeStatuses"));
});

test("instanceTracking activeStatuses with an empty-string statusField is flagged (silently polls every row otherwise)", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "",
        activeStatuses: ["planning"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].activeStatuses"));
});

test("instanceTracking terminalStatuses without statusField is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        terminalStatuses: ["abandoned"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].terminalStatuses"));
});

test("instanceTracking with statusField + terminalStatuses (no activeStatuses) has no issues", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        terminalStatuses: ["abandoned", "completed"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("instanceTracking declaring both activeStatuses and terminalStatuses is flagged (mutually exclusive)", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["planning"],
        terminalStatuses: ["abandoned"],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(
    issues.some(
      (i) =>
        i.path === "instanceTracking[0].terminalStatuses" &&
        /mutually exclusive/.test(i.message),
    ),
  );
});

test("instanceTracking treats an empty selector array as unset — both empty is NOT mutually-exclusive", () => {
  // The runtime gates on a non-empty array (`isConfiguredStatusSelector`), so an empty array means
  // "not configured". Validation must agree, or an equivalent manifest fails only at author time.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: [],
        terminalStatuses: [],
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("instanceTracking flags a non-array terminalStatuses (would become a Set of characters at runtime)", () => {
  // A JSON manifest can supply a bare string; typed construction can't. Parse it so the fixture is
  // genuinely runtime-invalid without an `as` cast.
  const bad = JSON.parse(
    '{"table":"plans","keyField":"process_key","statusField":"status","terminalStatuses":"abandoned","onTerminated":{"set":{"status":"abandoned"}}}',
  );
  const issues = collectManifestIssues({ ...valid, instanceTracking: [bad] });
  assert.ok(
    issues.some(
      (i) =>
        i.path === "instanceTracking[0].terminalStatuses" &&
        /array of non-empty strings/.test(i.message),
    ),
  );
});

test("instanceTracking flags a non-array activeStatuses (would crash activeStatuses.map at runtime)", () => {
  const bad = JSON.parse(
    '{"table":"plans","keyField":"process_key","statusField":"status","activeStatuses":"planning","onTerminated":{"set":{"status":"abandoned"}}}',
  );
  const issues = collectManifestIssues({ ...valid, instanceTracking: [bad] });
  assert.ok(
    issues.some(
      (i) =>
        i.path === "instanceTracking[0].activeStatuses" &&
        /array of non-empty strings/.test(i.message),
    ),
  );
});

test("instanceTracking flags a status selector array holding a non-string/empty entry", () => {
  const bad = JSON.parse(
    '{"table":"plans","keyField":"process_key","statusField":"status","terminalStatuses":["abandoned",""],"onTerminated":{"set":{"status":"abandoned"}}}',
  );
  const issues = collectManifestIssues({ ...valid, instanceTracking: [bad] });
  assert.ok(
    issues.some(
      (i) =>
        i.path === "instanceTracking[0].terminalStatuses" &&
        /array of non-empty strings/.test(i.message),
    ),
  );
});

test("instanceTracking pollMs that is non-positive/NaN/non-number is flagged (would hot-loop the poll timer)", () => {
  for (const badPollMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000"]) {
    const issues = collectManifestIssues({
      ...valid,
      instanceTracking: [
        {
          table: "plans",
          keyField: "process_key",
          statusField: "status",
          activeStatuses: ["planning"],
          onTerminated: { set: { status: "abandoned" } },
          pollMs: badPollMs,
        },
      ],
    });
    assert.ok(
      issues.some((i) => i.path === "instanceTracking[0].pollMs"),
      `expected pollMs=${String(badPollMs)} to be flagged`,
    );
  }
});

test("instanceTracking with a valid positive pollMs has no pollMs issue", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["planning"],
        onTerminated: { set: { status: "abandoned" } },
        pollMs: 5000,
      },
    ],
  });
  assert.deepEqual(issues, []);
});

// ── readModel (ADR 0065, the writer→source inversion) ───────────────────────────────────────────
// The new `instanceTracking.readModel` validation surface: identifier shape, base-table/statusField
// collisions (folded case-insensitively, matching SQLite), and duplicate managed-VIEW names across
// bindings. These lock the author-time guard to the VIEW-provisioning behavior it stands in for.

test("a valid instanceTracking.readModel override has no issues", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["planning"],
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "plans_status", statusColumn: "effective_status" },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("a non-object readModel is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: "nope",
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel"));
});

test("a non-identifier readModel.view / statusColumn is flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "has space", statusColumn: "1bad" },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel.view"));
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel.statusColumn"));
});

test("readModel.view colliding with the base table is flagged case-insensitively", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "Plans" }, // folds to the base table name
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel.view"));
});

test("a reserved-prefix readModel.view is flagged (hidden from the datasource surface)", () => {
  // A `_urban_*` / `_nano_*` / `sqlite_*` view provisions fine but is filtered out of gateway.schema(),
  // so a page reads `unknown table`. Reject it at author time, on the explicit override, case-insensitively.
  for (const view of ["_urban_status", "_NANO_status", "sqlite_meta"]) {
    const issues = collectManifestIssues({
      ...valid,
      instanceTracking: [
        {
          table: "plans",
          keyField: "process_key",
          statusField: "status",
          onTerminated: { set: { status: "abandoned" } },
          readModel: { view },
        },
      ],
    });
    assert.ok(
      issues.some((i) => i.path === "instanceTracking[0].readModel.view"),
      `expected reserved view "${view}" to be flagged`,
    );
  }
});

test("a reserved-prefix default VIEW (from a reserved base table) is flagged on `table`", () => {
  // With no override the VIEW defaults to `<table>__tracking`; a `_urban_*` base table therefore yields a
  // reserved default view name. The issue is attributed to `table` since there is no explicit view.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "_urban_plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].table"));
});

test("a reserved base table with a NON-reserved explicit view is flagged on `table` (issue #452 review)", () => {
  // The reserved-VIEW guard only inspects the effective VIEW NAME. A binding
  // `table: "_urban_instance_state", readModel: { view: "tracking" }` slips past it: the published
  // `tracking` VIEW is non-reserved (so gateway.schema() exposes it) yet SELECTs the runtime's hidden
  // sidecar rows. Tracking a reserved runtime table is never legitimate — reject it on `table`.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "_urban_instance_state",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "tracking" },
      },
    ],
  });
  assert.ok(
    issues.some((i) => i.path === "instanceTracking[0].table" && i.message.includes("reserved prefix")),
    "expected a reserved base-table issue on `table`",
  );
});

test("non-identifier table / keyField / statusField are flagged (they compile into VIEW SQL)", () => {
  // `table`/`keyField`/`statusField` are interpolated into the derived VIEW's DDL and predicates, so a
  // non-identifier (e.g. `external-orders`) that historically only passed the non-empty check would
  // validate yet throw at VIEW construction. Enforce the identifier rule at author time (No Drift).
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "external-orders",
        keyField: "process key",
        statusField: "the.status",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].table"));
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].keyField"));
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].statusField"));
});

test("a STATUS-LESS instanceTracking binding accepts a non-identifier table/keyField (no VIEW is built)", () => {
  // A binding with no `statusField` provisions no derived VIEW; it only feeds projections and is polled
  // through `api.data.table()`, whose `Table<T>` gateway `quoteIdent`s the base table + key column. So a
  // hyphenated/spaced name like `external-orders` / `process key` works and MUST NOT be rejected here —
  // the SQL_IDENT rule applies only when a VIEW is actually built (No Drift with provisioning).
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "external-orders",
        keyField: "process key",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(!issues.some((i) => i.path === "instanceTracking[0].table"));
  assert.ok(!issues.some((i) => i.path === "instanceTracking[0].keyField"));
});

test("an unknown key inside readModel is flagged (additionalProperties: false)", () => {
  // A typo like `statusColum` would silently fall back to the default derived column while the page reads
  // the wrong field. Mirror the `network` block's unknown-key rejection.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "plans_board", statusColum: "eff_status" },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel.statusColum"));
});

test("readModel.statusColumn colliding with statusField is flagged case-insensitively", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { statusColumn: "Status" }, // folds to statusField -> stored column shadows the derived one
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].readModel.statusColumn"));
});

test("two bindings folding to the same managed-VIEW name are flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
      },
      {
        // Same base table, no distinct override → both default to `plans__tracking`.
        table: "plans",
        keyField: "other_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[1].readModel.view"));
});

test("two bindings whose readModel.view differ only by case are flagged", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "shared_status" },
      },
      {
        table: "orders",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "Shared_Status" }, // folds to the first binding's view
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[1].readModel.view"));
});

test("distinct managed-VIEW names across bindings on the same table have no view collision", () => {
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "plans_a" },
      },
      {
        table: "plans",
        keyField: "other_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "plans_b" },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("statusField folding to the default derived column (no override) is flagged", () => {
  // With no `readModel.statusColumn`, the VIEW derives under the default `derived_status`. A binding
  // whose `statusField` IS `derived_status` therefore collides with the default derived column exactly
  // as an explicit override would — SQLite keeps the stored base column and the derived read is stale.
  // This is the omitted-override path the runtime would otherwise only discover at boot.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "Derived_Status", // folds to the default derived column name
        onTerminated: { set: { Derived_Status: "abandoned" } },
      },
    ],
  });
  assert.ok(issues.some((i) => i.path === "instanceTracking[0].statusField"));
});

test("an explicit readModel.statusColumn that differs from the default derived column is not falsely flagged", () => {
  // statusField == default derived column, but an explicit override moves the derived column elsewhere:
  // no collision, so the omitted-override guard must NOT fire.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "derived_status",
        onTerminated: { set: { derived_status: "abandoned" } },
        readModel: { statusColumn: "effective_status" },
      },
    ],
  });
  assert.deepEqual(issues, []);
});

test("a managed VIEW name colliding with another binding's base table is flagged", () => {
  // SQLite shares one namespace for tables and views: a managed VIEW named `orders` (binding 0) collides
  // with binding 1's base table `orders`, so `CREATE VIEW` would fail at boot and binding 0 loses its
  // derived surface. Reject it at author time.
  const issues = collectManifestIssues({
    ...valid,
    instanceTracking: [
      {
        table: "plans",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
        readModel: { view: "orders" }, // folds to binding[1]'s base table
      },
      {
        table: "orders",
        keyField: "process_key",
        statusField: "status",
        onTerminated: { set: { status: "abandoned" } },
      },
    ],
  });
  assert.ok(
    issues.some(
      (i) => i.path === "instanceTracking[0].readModel.view" && i.message.includes("base table"),
    ),
  );
});
