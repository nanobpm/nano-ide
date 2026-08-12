import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  fail,
  isOk,
  isFail,
  gen,
  map,
  mapError,
  match,
  tag,
  matchTags,
  scoped,
  acquireRelease,
  type Result,
  type Tagged,
} from "./index.ts";

test("ok/fail construct and narrow", () => {
  const a = ok(42);
  const b = fail("boom");
  assert.equal(isOk(a), true);
  assert.equal(isFail(a), false);
  assert.equal(isOk(b), false);
  assert.equal(isFail(b), true);
  if (isOk(a)) assert.equal(a.value, 42);
  if (isFail(b)) assert.equal(b.error, "boom");
});

test("gen threads values through yield* on the happy path", () => {
  const r = gen(function* () {
    const x = yield* ok(2);
    const y = yield* ok(3);
    return x + y;
  });
  assert.equal(isOk(r), true);
  if (isOk(r)) assert.equal(r.value, 5);
});

test("gen short-circuits on the first failure", () => {
  const steps: string[] = [];
  const r = gen(function* () {
    steps.push("a");
    const x = yield* ok(1);
    steps.push("b");
    yield* fail("nope");
    steps.push("c"); // must not run
    return x;
  });
  assert.equal(isFail(r), true);
  if (isFail(r)) assert.equal(r.error, "nope");
  assert.deepEqual(steps, ["a", "b"]);
});

test("gen unions error types from multiple failure sources", () => {
  const parse = (s: string) => (s === "" ? fail(tag("Empty")) : ok(s.length));
  const check = (n: number) => (n > 3 ? fail(tag("TooLong")) : ok(n));
  const run = (s: string) =>
    gen(function* () {
      const n = yield* parse(s);
      const ok2 = yield* check(n);
      return ok2;
    });

  const good = run("ab");
  assert.equal(isOk(good), true);
  if (isOk(good)) assert.equal(good.value, 2);

  const empty = run("");
  assert.equal(isFail(empty), true);
  if (isFail(empty)) assert.equal(empty.error._tag, "Empty");

  const long = run("abcd");
  assert.equal(isFail(long), true);
  if (isFail(long)) assert.equal(long.error._tag, "TooLong");
});

test("map/mapError/match", () => {
  assert.equal(match(map(ok(2), (n) => n * 10), (a) => a, () => -1), 20);
  const failed: Result<number, string> = fail("e");
  assert.equal(match(map(failed, (n) => n * 10), (n) => String(n), (e) => e), "e");
  assert.equal(match(mapError(fail("e"), (e) => e + "!"), () => "", (e) => e), "e!");
  assert.equal(match(mapError(ok(7), (e: string) => e), (a) => a, () => -1), 7);
});

test("tag builds tagged errors with props", () => {
  const e = tag("Http", { status: 404 });
  assert.equal(e._tag, "Http");
  assert.equal(e.status, 404);
});

test("matchTags dispatches on the tag", () => {
  type E = Tagged<"NotFound"> | (Tagged<"Denied"> & { who: string });
  const describe = (e: E) =>
    matchTags(e, {
      NotFound: () => "missing",
      Denied: (d) => `denied:${d.who}`,
    });
  assert.equal(describe(tag("NotFound")), "missing");
  assert.equal(describe(tag("Denied", { who: "bob" })), "denied:bob");
});

test("tag distributes a union tag into a discriminated union for matchTags", () => {
  // `outcome` is a plain string union, as returned by e.g. a land/merge step.
  const dispatch = (outcome: "merged" | "queued" | "blocked", detail: string) =>
    matchTags(tag(outcome, { detail }), {
      merged: () => "done",
      queued: () => "waiting",
      // The shared `detail` prop is present on every variant.
      blocked: (b) => `blocked:${b.detail}`,
    });
  assert.equal(dispatch("merged", "x"), "done");
  assert.equal(dispatch("queued", "x"), "waiting");
  assert.equal(dispatch("blocked", "perms"), "blocked:perms");
});

test("scoped releases resources LIFO on success", async () => {
  const released: string[] = [];
  const out = await scoped(async (scope) => {
    acquireRelease(scope, () => "a", () => { released.push("a"); });
    acquireRelease(scope, () => "b", () => { released.push("b"); });
    return "done";
  });
  assert.equal(out, "done");
  assert.deepEqual(released, ["b", "a"]);
});

test("scoped releases resources even when the body throws", async () => {
  const released: string[] = [];
  await assert.rejects(
    scoped(async (scope) => {
      acquireRelease(scope, () => "a", () => { released.push("a"); });
      acquireRelease(scope, () => "b", () => { released.push("b"); });
      throw new Error("kaboom");
    }),
    /kaboom/,
  );
  assert.deepEqual(released, ["b", "a"]);
});

test("scoped best-effort: a failing disposer does not block the others", async () => {
  const released: string[] = [];
  await scoped(async (scope) => {
    acquireRelease(scope, () => "a", () => { released.push("a"); });
    acquireRelease(scope, () => "b", () => { throw new Error("dispose fail"); });
    acquireRelease(scope, () => "c", () => { released.push("c"); });
    return null;
  });
  // b's disposer threw but a and c still ran (LIFO: c, [b throws], a).
  assert.deepEqual(released, ["c", "a"]);
});
