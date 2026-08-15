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
