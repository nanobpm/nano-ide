// Slice S7 (adversarial) — cross-instance SHARING semantics.
//
// Proves the "private-per-app / shared-on-same-name" contract can't be broken:
// two instances naming the SAME context (repo+ref) see each other's ratified
// writes, and two instances naming DISTINCT contexts stay isolated. Exercised at
// both the S1 identity layer and end-to-end through S3's write path + S4 reads.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  type ContextBinding,
  contextIdentityKey,
  resolveContextIdentity,
  sameContext,
} from "../binding/index.ts";
import { ContextWriter } from "../git/index.ts";
import { ContextRetriever } from "../retrieval/index.ts";
import { cleanup, makeSubstrate, rec } from "./harness.ts";

const TEMP_ROOTS: string[] = [];
after(() => cleanup(TEMP_ROOTS));

const binding = (repo: string, ref: string): ContextBinding => ({ repo, ref });

test("identity: same (repo, ref) name shares; a distinct name stays private", () => {
  const a = binding("nanobpm/nano-ide", "main");
  const same = binding("nanobpm/nano-ide", "main");
  const otherRef = binding("nanobpm/nano-ide", "release");
  const otherRepo = binding("nanobpm/nano-workforce", "main");

  assert.equal(sameContext(a, same), true);
  assert.equal(contextIdentityKey(a), contextIdentityKey(same));

  // A different ref OR a different repo is a genuinely different context.
  assert.equal(sameContext(a, otherRef), false);
  assert.equal(sameContext(a, otherRepo), false);
  assert.notEqual(contextIdentityKey(a), contextIdentityKey(otherRef));
  assert.notEqual(contextIdentityKey(a), contextIdentityKey(otherRepo));

  // On-disk slug tracks the key: shared names → shared location; distinct → not.
  assert.equal(resolveContextIdentity(a).slug, resolveContextIdentity(same).slug);
  assert.notEqual(resolveContextIdentity(a).slug, resolveContextIdentity(otherRef).slug);
});

test("identity: equivalent repo spellings collapse to one shared substrate", () => {
  // Shorthand, HTTPS clone URL, and a credentialed URL all name one context.
  // The credentialed form uses the repo's redacted userinfo placeholder (`***@`)
  // — it still exercises the "userinfo must not affect identity" invariant
  // without embedding a credential-in-URL literal that trips secret scanning.
  const shorthand = binding("nanobpm/nano-ide", "main");
  const https = binding("https://github.com/nanobpm/nano-ide.git", "main");
  const credential = binding("https://***@github.com/nanobpm/nano-ide.git", "main");

  assert.equal(sameContext(shorthand, https), true);
  assert.equal(sameContext(shorthand, credential), true, "credentials must not split identity");
});

test("end-to-end: a second instance on the same context reads the first's write", async () => {
  const shared = await makeSubstrate(TEMP_ROOTS);

  // Instance A writes a ratified fact into the shared substrate.
  const writerA = new ContextWriter({ localPath: shared, ref: "main" });
  await writerA.appendRecord(
    rec({ id: "shared-fact", scope: "epic", scopeRef: "issue-303", statement: "A observed 42 rps" }),
  );

  // Instance B — a distinct object naming the SAME context — sees it.
  const retrieverB = new ContextRetriever({ localPath: shared, ref: "main" });
  const seenByB = await retrieverB.all();
  assert.equal(seenByB.some((s) => s.record.id === "shared-fact"), true);
});

test("end-to-end: a distinct-name instance cannot see another context's writes", async () => {
  const shared = await makeSubstrate(TEMP_ROOTS);
  const other = await makeSubstrate(TEMP_ROOTS);

  const writerA = new ContextWriter({ localPath: shared, ref: "main" });
  await writerA.appendRecord(rec({ id: "private-fact", statement: "only visible in shared" }));

  const retrieverOther = new ContextRetriever({ localPath: other, ref: "main" });
  const seen = await retrieverOther.all();
  assert.equal(seen.some((s) => s.record.id === "private-fact"), false);
  assert.equal(seen.length, 0, "an unrelated context must stay empty/private");
});
