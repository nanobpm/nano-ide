import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectCliProjection,
  collectOperations,
  effectiveCliAudience,
  type OpenApiDoc,
  parseCliExtension,
  parseSpec,
} from "./spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "cli-projection.fixture.yaml");
const SNAPSHOT = resolve(HERE, "cli-projection.snapshot.json");

test("parseCliExtension: absent → undefined", () => {
  assert.equal(parseCliExtension(undefined), undefined);
});

test("parseCliExtension: minimal command form normalises optional keys", () => {
  assert.deepEqual(parseCliExtension({ command: ["start", "feature"] }), {
    command: ["start", "feature"],
    exclude: false,
    positional: [],
    aliases: [],
  });
});

test("parseCliExtension: full form", () => {
  assert.deepEqual(
    parseCliExtension({
      command: ["start", "feature"],
      exclude: false,
      audience: "operator",
      positional: ["issue"],
      aliases: [["feature", "start"]],
    }),
    {
      command: ["start", "feature"],
      exclude: false,
      audience: "operator",
      positional: ["issue"],
      aliases: [["feature", "start"]],
    },
  );
});

test("parseCliExtension: exclude: true makes command optional", () => {
  assert.deepEqual(parseCliExtension({ exclude: true }), { command: [], exclude: true, positional: [], aliases: [] });
});

const errors: [string, unknown, RegExp][] = [
  ["non-object", ["start"], /^Error: w: must be an object/],
  ["unknown key", { command: ["a"], verb: "x" }, /^Error: w: unknown key "verb"/],
  ["missing command", {}, /^Error: w\.command: must be a non-empty array/],
  ["empty command", { command: [] }, /^Error: w\.command: must be a non-empty array/],
  ["string command", { command: "start" }, /^Error: w\.command: must be a non-empty array/],
  ["non-kebab word", { command: ["start", "deliveryGraph"] }, /^Error: w\.command\[1\]: "deliveryGraph" is not a kebab-case word/],
  ["empty word", { command: [""] }, /^Error: w\.command\[0\]: "" is not a kebab-case word/],
  ["non-string word", { command: [1] }, /^Error: w\.command\[0\]: 1 is not a kebab-case word/],
  ["non-boolean exclude", { command: ["a"], exclude: "yes" }, /^Error: w\.exclude: must be a boolean/],
  ["unknown audience", { command: ["a"], audience: "admin" }, /^Error: w\.audience: "admin" is not one of: operator/],
  ["non-array positional", { command: ["a"], positional: "issue" }, /^Error: w\.positional: must be an array/],
  ["empty positional", { command: ["a"], positional: [""] }, /^Error: w\.positional\[0\]: must be a non-empty string/],
  ["duplicate positional", { command: ["a"], positional: ["x", "x"] }, /^Error: w\.positional: duplicate field "x"/],
  ["non-array aliases", { command: ["a"], aliases: ["b"] }, /^Error: w\.aliases\[0\]: must be a non-empty array/],
  ["non-kebab alias", { command: ["a"], aliases: [["B"]] }, /^Error: w\.aliases\[0\]\[0\]: "B" is not a kebab-case word/],
];
for (const [name, ext, re] of errors) {
  test(`parseCliExtension rejects ${name} with a path-qualified error`, () => {
    assert.throws(() => parseCliExtension(ext, "w"), re);
  });
}

function docWith(ops: Record<string, Record<string, unknown>>): OpenApiDoc {
  const paths: Record<string, unknown> = {};
  for (const [path, op] of Object.entries(ops)) paths[path] = { post: { responses: {}, ...op } };
  return JSON.parse(JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "0" }, paths }));
}

test("collectOperations exposes the parsed x-cli as `cli` and errors are path-qualified", () => {
  const ops = collectOperations(docWith({ "/a": { operationId: "a", "x-cli": { command: ["do", "a"] } } }));
  assert.deepEqual(ops[0].cli?.command, ["do", "a"]);
  assert.throws(
    () => collectOperations(docWith({ "/a": { operationId: "a", "x-cli": { command: ["Do"] } } })),
    /^Error: paths\.\/a\.post\.x-cli\.command\[0\]/,
  );
  assert.equal(collectOperations(docWith({ "/b": { operationId: "b" } }))[0].cli, undefined);
});

test("collectOperations rejects duplicate command paths across operations", () => {
  assert.throws(
    () =>
      collectOperations(
        docWith({
          "/a": { operationId: "a", "x-cli": { command: ["start", "feature"] } },
          "/b": { operationId: "b", "x-cli": { command: ["start", "feature"] } },
        }),
      ),
    /paths\.\/b\.post\.x-cli\.command: duplicate command path "start feature" \(already declared at paths\.\/a\.post\.x-cli\.command\)/,
  );
});

test("an alias colliding with another operation's command is a duplicate", () => {
  assert.throws(
    () =>
      collectOperations(
        docWith({
          "/a": { operationId: "a", "x-cli": { command: ["start", "feature"] } },
          "/b": { operationId: "b", "x-cli": { command: ["go"], aliases: [["start", "feature"]] } },
        }),
      ),
    /paths\.\/b\.post\.x-cli\.aliases\[0\]: duplicate command path "start feature"/,
  );
});

test("excluded operations do not claim command paths", () => {
  const ops = collectOperations(
    docWith({
      "/a": { operationId: "a", "x-cli": { command: ["x"], exclude: true } },
      "/b": { operationId: "b", "x-cli": { command: ["x"] } },
    }),
  );
  assert.equal(ops.length, 2);
});

test("effectiveCliAudience: x-mcp-excluded without x-cli defaults to operator; x-cli wins", () => {
  const none = { exclude: false, command: ["a"], positional: [], aliases: [] };
  assert.equal(effectiveCliAudience({ mcpExcluded: true }), "operator");
  assert.equal(effectiveCliAudience({ mcpExcluded: false }), undefined);
  assert.equal(effectiveCliAudience({ mcpExcluded: true, cli: none }), undefined);
  assert.equal(effectiveCliAudience({ mcpExcluded: false, cli: { ...none, audience: "operator" } }), "operator");
});

test("CLI projection of the fixture matches the committed snapshot", () => {
  const current = `${JSON.stringify(collectCliProjection(parseSpec(readFileSync(FIXTURE, "utf8"))), null, 2)}\n`;
  if (process.env.UPDATE_CLI_SNAPSHOT === "1") writeFileSync(SNAPSHOT, current);
  assert.equal(current, readFileSync(SNAPSHOT, "utf8"), "regenerate with UPDATE_CLI_SNAPSHOT=1 and review the diff");
});
