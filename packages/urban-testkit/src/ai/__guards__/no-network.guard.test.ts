// S5 no-network / determinism guard (issue #297) — the single most important guard.
//
// The default AI-assertion path MUST be deterministic and network-free: running
// `matchesSemantically` and `satisfiesJudge` on the default (fake) backends must never
// touch the network, and no real adapter may be LIVE-activated without the explicit
// `URBAN_TESTKIT_AI_REAL` opt-in. This guard installs spies over `fetch` (both runtimes)
// and, best-effort where reachable, `node:net` socket connect, proves the matchers stay
// off the wire, and proves every S4 construction factory throws /requires explicit opt-in/
// BEFORE any dynamic import()/network when the opt-in is unset.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertThatText,
  createHostedProviderAdapters,
  createLocalModelAdapters,
  createRealAdapters,
  createRealChatModelAdapter,
  createRealEmbeddingAdapter,
  createRecordingChatModelAdapter,
  createRecordingEmbeddingAdapter,
} from "../index.ts";
import { Cassette } from "../record-replay.ts";
import { isRealAiEnabled } from "../adapters/real/env.ts";

interface NetworkSpy {
  touched: () => boolean;
}

/** Installs a `fetch` spy that records + throws, restoring the exact prior shape after. */
function installFetchSpy(record: () => void): () => void {
  const hadFetch = Reflect.has(globalThis, "fetch");
  const original = Reflect.get(globalThis, "fetch");
  const stubInstalled = Reflect.set(globalThis, "fetch", (..._args: readonly unknown[]) => {
    record();
    throw new Error("network access (fetch) is blocked in the no-network guard");
  });
  assert.equal(
    stubInstalled,
    true,
    "fetch stub must install so stray network access stays detectable",
  );
  return () => {
    if (!hadFetch) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Reflect.set(globalThis, "fetch", original);
    }
  };
}

/**
 * Best-effort spy over `node:net` socket connect, so a raw TCP dial (not just `fetch`) is
 * also caught where the runtime exposes it. Failures to patch are swallowed: the guard is
 * runtime-neutral and `fetch` is the primary detector — the socket spy is a bonus net.
 */
async function installNetConnectSpy(record: () => void): Promise<() => void> {
  const restores: Array<() => void> = [];
  try {
    const net = await import("node:net");
    const proto = net.Socket?.prototype;
    if (proto !== undefined && typeof proto.connect === "function") {
      const originalConnect = proto.connect;
      const spy = function connect(this: unknown, ..._args: readonly unknown[]): unknown {
        record();
        throw new Error("network access (socket connect) is blocked in the no-network guard");
      };
      Reflect.set(proto, "connect", spy);
      restores.push(() => {
        Reflect.set(proto, "connect", originalConnect);
      });
    }
  } catch {
    // node:net not reachable in this runtime — fetch spy remains the guarantee.
  }
  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}

async function withNetworkBlocked(body: (spy: NetworkSpy) => Promise<void>): Promise<void> {
  let touched = false;
  const record = () => {
    touched = true;
  };
  const restoreFetch = installFetchSpy(record);
  const restoreNet = await installNetConnectSpy(record);
  const spy: NetworkSpy = { touched: () => touched };
  try {
    await body(spy);
  } finally {
    restoreNet();
    restoreFetch();
  }
}

test("no-network guard precondition: the LIVE real-adapter opt-in is OFF on the default path", () => {
  assert.equal(isRealAiEnabled(), false);
});

test("no-network guard: matchesSemantically on the default fake never touches the network", async () => {
  await withNetworkBlocked(async (spy) => {
    // Identical text → cosine 1.0 ≥ default threshold → passes, all on the deterministic fake.
    await assertThatText("a friendly greeting").matchesSemantically("a friendly greeting");
    assert.equal(spy.touched(), false, "matchesSemantically must not reach the network");
  });
});

test("no-network guard: satisfiesJudge on the default fake never touches the network", async () => {
  await withNetworkBlocked(async (spy) => {
    await assertThatText("a warm friendly greeting to you").satisfiesJudge("friendly greeting");
    assert.equal(spy.touched(), false, "satisfiesJudge must not reach the network");
  });
});

test("no-network guard: a failing matcher assertion still never touches the network", async () => {
  await withNetworkBlocked(async (spy) => {
    await assert.rejects(
      assertThatText("completely unrelated words").matchesSemantically("nothing alike here", {
        threshold: 0.8,
      }),
      /matchesSemantically failed/,
    );
    assert.equal(spy.touched(), false, "a failing matcher must not reach the network either");
  });
});

test("no-network guard: no real adapter can be LIVE-activated without opt-in (factories reject, no network)", async () => {
  await withNetworkBlocked(async (spy) => {
    const cassette = new Cassette(null);
    // Each factory must throw the opt-in error BEFORE any dynamic import()/network I/O — a
    // missing optional dep would instead surface as a module-resolution error.
    const attempts = [
      createRealAdapters(),
      createRealAdapters({ provider: "local" }),
      createRealEmbeddingAdapter(),
      createRealChatModelAdapter(),
      createHostedProviderAdapters(),
      createLocalModelAdapters(),
      createRecordingEmbeddingAdapter({ cassette }),
      createRecordingChatModelAdapter({ cassette }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, /requires explicit opt-in/);
    }
    assert.equal(spy.touched(), false, "an opt-in-gated factory must not touch the network");
  });
});
