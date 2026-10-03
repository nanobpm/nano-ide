import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickProcessDefinitionIdentity,
  presentEngineKey,
  presentString,
} from "./process-identity.ts";

// The canonical, adapter-agnostic process-definition-identity normalizer. Both the live SDK adapter
// (`engine/nanosdk.ts`) and the WASM test adapter (`@nanobpm/urban-testkit`) route through this ONE
// mapping, so these cases pin the class the shared helper exists to keep consistent (No Drift
// Surfaces): a padded/numeric key is normalized, a blank/whitespace/non-string/non-finite value is
// *absent* and never coerced, and a version is kept only when a positive integer number.

test("presentEngineKey coerces a finite numeric key, trims a string, and drops blank/non-finite/non-string", () => {
  assert.equal(presentEngineKey(7), "7");
  assert.equal(presentEngineKey(" order "), "order");
  assert.equal(presentEngineKey("   "), undefined);
  assert.equal(presentEngineKey(""), undefined);
  assert.equal(presentEngineKey(Number.NaN), undefined);
  assert.equal(presentEngineKey(Number.POSITIVE_INFINITY), undefined);
  assert.equal(presentEngineKey({}), undefined);
  assert.equal(presentEngineKey(null), undefined);
  assert.equal(presentEngineKey(undefined), undefined);
});

test("presentString keeps a trimmed non-empty string and drops blank/non-string (never coerces)", () => {
  assert.equal(presentString(" human "), "human");
  assert.equal(presentString("   "), undefined);
  assert.equal(presentString(""), undefined);
  // A number id is absent — never String(...)-coerced into a garbage id.
  assert.equal(presentString(5), undefined);
  assert.equal(presentString({}), undefined);
  assert.equal(presentString(undefined), undefined);
});

test("pickProcessDefinitionIdentity normalizes present fields and omits blank/malformed ones", () => {
  assert.deepEqual(
    pickProcessDefinitionIdentity({
      processDefinitionKey: 7,
      processDefinitionId: " order ",
      processDefinitionVersion: 2,
    }),
    { processDefinitionKey: "7", processDefinitionId: "order", processDefinitionVersion: 2 },
  );
});

test("pickProcessDefinitionIdentity drops a blank key, a non-string id, and a stringly version", () => {
  assert.deepEqual(
    pickProcessDefinitionIdentity({
      processDefinitionKey: "  ",
      processDefinitionId: 5,
      processDefinitionVersion: "2",
    }),
    {},
  );
});

test("pickProcessDefinitionIdentity keeps a version only when a positive integer number", () => {
  assert.deepEqual(pickProcessDefinitionIdentity({ processDefinitionVersion: 1.5 }), {});
  assert.deepEqual(pickProcessDefinitionIdentity({ processDefinitionVersion: 0 }), {});
  assert.deepEqual(pickProcessDefinitionIdentity({ processDefinitionVersion: -1 }), {});
  assert.deepEqual(pickProcessDefinitionIdentity({ processDefinitionVersion: 3 }), {
    processDefinitionVersion: 3,
  });
});

test("pickProcessDefinitionIdentity on an empty row returns an empty identity (fully absent)", () => {
  assert.deepEqual(pickProcessDefinitionIdentity({}), {});
});
