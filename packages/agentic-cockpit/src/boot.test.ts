import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFrame, encodeFrame, type Frame } from "@nanobpm/agentic-protocol";
import type { DemandSupplyReport } from "@nanobpm/agentic-demand";

import { bootCockpit, type CockpitEnv } from "./boot.ts";
import { FakeDocument, FakeElement } from "./fake-dom.ts";
import type { RawSocket } from "./relay-client.ts";

class FakeSocket implements RawSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onOpen: (() => void) | undefined;
  #onClose: (() => void) | undefined;
  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(l: (bytes: Uint8Array) => void): void {
    this.#onMessage = l;
  }
  onOpen(l: () => void): void {
    this.#onOpen = l;
  }
  onClose(l: () => void): void {
    this.#onClose = l;
  }
  fireOpen(): void {
    this.#onOpen?.();
  }
  fireClose(): void {
    this.#onClose?.();
  }
  deliver(frame: Frame): void {
    this.#onMessage?.(encodeFrame(frame));
  }
  subscribeFrames(): Frame[] {
    return this.sent.map(decodeFrame).filter((f) => f.family === "relay");
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function reportWith(networks: DemandSupplyReport["networks"], missing: string[] = []): DemandSupplyReport {
  return {
    networks,
    missing,
    diversity: { status: "green", roles: [] },
    status: missing.length > 0 ? "red" : "green",
    nonAgentic: [],
  };
}

const served = reportWith([
  { network: "ci", tokens: [{ token: "ci.build", supply: 1, instances: ["ci-a"], satisfied: true }], missing: [] },
]);

interface Rig {
  readonly env: CockpitEnv;
  readonly host: FakeElement;
  readonly sockets: FakeSocket[];
  readonly terminalWrites: string[];
  terminalMounts: number;
  readonly timers: Array<{ run: () => void; ms: number }>;
  reconnect: (() => void) | undefined;
  report: DemandSupplyReport;
  errors: unknown[];
}

function rig(): Rig {
  const host = new FakeElement("body");
  const sockets: FakeSocket[] = [];
  const terminalWrites: string[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const state: Rig = {
    host,
    sockets,
    terminalWrites,
    terminalMounts: 0,
    timers,
    reconnect: undefined,
    report: served,
    errors: [],
    env: {
      host,
      doc: new FakeDocument(),
      fetchReport: () => Promise.resolve(state.report),
      connectRelay: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      createTerminal: (terminalHost) => {
        state.terminalMounts += 1;
        terminalHost.appendChild(new FakeElement("pre"));
        return { write: (chunk) => terminalWrites.push(chunk) };
      },
      schedule: (run) => {
        state.reconnect = run;
      },
      setTimer: (run, ms) => {
        timers.push({ run, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
      onError: (err) => state.errors.push(err),
    },
  };
  return state;
}

test("refresh renders the live demand×supply matrix into the host", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  assert.equal(r.host.byData("network", "ci").length, 1);
  assert.equal(r.host.byClass("cockpit-token").length, 1);
});

test("a later poll reflects a changed report (a newly missing agent type lights red)", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  assert.equal(r.host.byClass("cockpit-network")[0]?.getAttribute("data-status"), "green");

  r.report = reportWith(
    [
      {
        network: "ci",
        tokens: [{ token: "ci.build", supply: 0, instances: [], satisfied: false }],
        missing: ["ci.build"],
      },
    ],
    ["ci.build"],
  );
  await cockpit.refresh();
  assert.equal(r.host.byData("network", "ci")[0]?.getAttribute("data-status"), "red");
  const missing = r.host.byClass("cockpit-light").filter((l) => l.getAttribute("data-light-id")?.startsWith("missing:"));
  assert.equal(missing.length, 1);
});

test("drilling into a worker subscribes its relay stream on connect", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");
  assert.equal(cockpit.currentStream, "ci-a");
  assert.equal(r.sockets.length, 1);

  r.sockets[0]?.fireOpen(); // (re)connect → session.attach()
  const subs = r.sockets[0]?.subscribeFrames() ?? [];
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0]?.payload, { op: "subscribe", stream: "ci-a", from: 0, credit: 1024 });
});

test("relay output is written to the drilled worker's terminal", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");
  r.sockets[0]?.fireOpen();
  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "ci-a", offset: 0, chunk: "boot\n" } });
  assert.deepEqual(r.terminalWrites, ["boot\n"]);
});

test("the terminal survives a matrix refresh — it is not re-mounted and keeps streaming", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");
  r.sockets[0]?.fireOpen();
  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "ci-a", offset: 0, chunk: "a" } });

  await cockpit.refresh(); // a poll re-renders the matrix
  assert.equal(r.terminalMounts, 1, "the terminal was not re-mounted by the refresh");

  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "ci-a", offset: 1, chunk: "b" } });
  assert.deepEqual(r.terminalWrites, ["a", "b"]);
});

test("the terminal survives a cockpit reconnect — resume-from-offset, no loss, no dup", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");

  const s1 = r.sockets[0];
  s1?.fireOpen();
  s1?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "ci-a", offset: 0, chunk: "a" } });
  s1?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "ci-a", offset: 1, chunk: "b" } });

  // The cockpit's socket drops; the client schedules a reconnect.
  s1?.fireClose();
  assert.ok(r.reconnect !== undefined, "a reconnect was scheduled");
  r.reconnect?.();
  assert.equal(r.sockets.length, 2, "a fresh socket was opened");

  const s2 = r.sockets[1];
  s2?.fireOpen(); // re-attach → resume from offset 2
  const subs = s2?.subscribeFrames() ?? [];
  assert.deepEqual(subs.at(-1)?.payload, { op: "subscribe", stream: "ci-a", from: 2, credit: 1024 });

  // The hub replays the retained tail (re-sends 1) then continues.
  s2?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "ci-a", offset: 1, chunk: "b" } });
  s2?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "ci-a", offset: 2, chunk: "c" } });
  assert.deepEqual(r.terminalWrites, ["a", "b", "c"], "no lost and no duplicated output across reconnect");
});

test("drilling the same stream twice does not re-open; a different stream switches", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");
  cockpit.drill("ci-a");
  assert.equal(r.sockets.length, 1);
  assert.equal(r.terminalMounts, 1);

  cockpit.drill("ci-b");
  assert.equal(r.sockets[0]?.closed, true, "the previous connection was closed");
  assert.equal(r.sockets.length, 2);
  assert.equal(r.terminalMounts, 2);
  assert.equal(cockpit.currentStream, "ci-b");
});

test("start runs a pass and self-schedules the next; stop halts it", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  cockpit.start();
  await flush();
  assert.equal(r.host.byData("network", "ci").length, 1, "first pass rendered");
  assert.equal(r.timers.length, 1, "next pass scheduled once");

  r.timers[0]?.run(); // fire the scheduled tick
  await flush();
  assert.equal(r.timers.length, 2, "a subsequent pass was scheduled");

  cockpit.stop();
  const before = r.timers.length;
  await flush();
  assert.equal(r.timers.length, before, "no further passes after stop");
});

test("a fetch error is reported and does not wedge the poll", async () => {
  const r = rig();
  const failing: CockpitEnv = { ...r.env, fetchReport: () => Promise.reject(new Error("boom")) };
  const cockpit = bootCockpit(failing);
  await cockpit.refresh();
  assert.equal(r.errors.length, 1);
});

test("dispose stops polling and closes the terminal connection", async () => {
  const r = rig();
  const cockpit = bootCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("ci-a");
  cockpit.dispose();
  assert.equal(r.sockets[0]?.closed, true);
});
