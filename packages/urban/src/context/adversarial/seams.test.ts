// Slice S7 (adversarial) — the pluggable SEAMS don't leak a backend assumption.
//
// Retrieval must be correct from a COLD/empty derived cache (git is
// authoritative, the cache is a disposable projection), and the binding / read
// seams must NOT hard-wire "exclusively public git" — local paths, file:// URLs
// and ssh remotes are first-class, and a custom RecordSource can back retrieval
// without any git at all.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { resolveContextIdentity, sameContext } from "../binding/index.ts";
import { ContextWriter } from "../git/index.ts";
import {
  ContextRetriever,
  type NamespaceSelector,
  type RecordSource,
  type StoredRecord,
} from "../retrieval/index.ts";
import type { MemoryRecord } from "../schema/index.ts";
import { cleanup, makeSubstrate, rec } from "./harness.ts";

const TEMP_ROOTS: string[] = [];
after(() => cleanup(TEMP_ROOTS));

test("retrieval is correct on a COLD cache — the first query falls back to git", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await writer.appendRecord(rec({ id: "cold-1", scope: "epic", scopeRef: "issue-303" }));
  await writer.appendRecord(rec({ id: "cold-2", scope: "repo", scopeRef: "nano-ide", statement: "s2" }));

  // Brand-new retriever: the derived cache is cold. This FIRST query has no
  // warmed snapshot to read, so it falls back to git — and, as a side effect,
  // populates the snapshot. We assert the cold-path result is complete.
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const cold = await retriever.query({});
  assert.equal(cold.length, 2, "a cold cache must still return every record via git");

  // A path-scoped structured query on a cold cache reads just that partition.
  const scoped = await retriever.byNamespace("repo", "nano-ide");
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].record.id, "cold-2");
});

test("git is authoritative — the derived cache is disposable and rebuildable", async () => {
  const dir = await makeSubstrate(TEMP_ROOTS);
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await writer.appendRecord(rec({ id: "auth-1" }));

  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal((await retriever.all()).length, 1); // warms the cache

  // A write happens in git AFTER the cache was warmed.
  await writer.appendRecord(rec({ id: "auth-2", scope: "repo", scopeRef: "nano-ide", statement: "later" }));

  // The stale snapshot doesn't see it; invalidating rebuilds purely from git.
  retriever.invalidate();
  const rebuilt = await retriever.all();
  assert.equal(rebuilt.length, 2, "cache must rebuild the full truth from git");
  assert.equal(rebuilt.some((s) => s.record.id === "auth-2"), true);

  // The forward-compat embedding seam is opt-in and absent in the MVP.
  assert.equal(retriever.embeddingIndex, undefined);
});

test("the READ seam is pluggable — retrieval works over a non-git RecordSource", async () => {
  const record: MemoryRecord = rec({ id: "mem-1", subject: "latency", statement: "backend-agnostic" });
  const stored: StoredRecord = { path: "records/epic/issue-303/mem-1.md", record };

  // An in-memory source that never touches git — proving the seam isn't
  // hard-wired to "exclusively public git".
  const memorySource: RecordSource = {
    async list(_selector?: NamespaceSelector) {
      return [stored];
    },
    async read(relPath: string) {
      return relPath === stored.path ? stored : undefined;
    },
  };

  const retriever = new ContextRetriever("/unused/path", { source: memorySource });
  const all = await retriever.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].record.id, "mem-1");
  const bySubject = await retriever.query({ subject: "latency" });
  assert.equal(bySubject.length, 1);
});

test("binding identity is NOT hard-wired to public GitHub — local/file/ssh are first-class", () => {
  // A local path and its file:// spelling name the SAME (self-hosted) context.
  const localPath = "/srv/substrates/ctx";
  const local = resolveContextIdentity({ repo: localPath, ref: "main" });
  assert.ok(local.key.length > 0, "a local-path substrate must resolve to an identity");
  assert.equal(sameContext({ repo: localPath, ref: "main" }, { repo: `file://${localPath}`, ref: "main" }), true);

  // An ssh remote resolves too, and differs from an unrelated host.
  const ssh = resolveContextIdentity({ repo: "git@example.com:team/ctx.git", ref: "main" });
  assert.ok(ssh.key.length > 0);
  assert.notEqual(ssh.key, local.key);
});
