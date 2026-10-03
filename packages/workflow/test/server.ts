// Test helper: manage a dedicated nanobpmn gateway for integration tests.
// Never touches a gateway you already have running — each Gateway gets its own
// temp data dir + a free port. Requires a built gateway binary; integration
// tests skip themselves when one isn't found (so unit-only CI stays green).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
// packages/workflow -> repo root is two levels up (packages/workflow/../..).
const REPO_ROOT = join(PKG_ROOT, "..", "..");

/** Locate a built gateway binary, or null if none is available. */
export function resolveServerBin(): string | null {
  if (process.env.SERVER_BIN && existsSync(process.env.SERVER_BIN)) return process.env.SERVER_BIN;
  const rel = ["debug", "release"].map((p) => join("server", "target", p, "nanobpm-gateway-rest-server"));
  // The gateway lives in the sibling nanobpmn checkout (not in this repo), so also probe a
  // `nanobpmn` repo checked out alongside or one level above nano-ide.
  const roots = [
    REPO_ROOT,
    join(REPO_ROOT, "..", "nanobpmn"),
    join(REPO_ROOT, "..", "..", "nanobpmn"),
  ];
  for (const root of roots) for (const r of rel) {
    const cand = join(root, r);
    if (existsSync(cand)) return cand;
  }
  return null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A dedicated gateway process bound to a fixed data dir + port (so it can be
 *  killed and restarted against the same journal). */
export class Gateway {
  readonly baseUrl: string;
  readonly bin: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logDir: string;
  private proc: ChildProcess | null = null;
  private restarts = 0;

  private constructor(bin: string, port: number, dataDir: string, logDir: string) {
    this.bin = bin;
    this.port = port;
    this.dataDir = dataDir;
    this.logDir = logDir;
    this.baseUrl = `http://localhost:${port}`;
  }

  /** Allocate a fresh scratch dir + port and **start** the gateway, resolving once it serves
   *  `/v2/topology`. The only way to obtain a `Gateway`: there is deliberately no
   *  "allocated but not started" handle, so a test cannot point a client at a `baseUrl` nothing
   *  is listening on (the `fetch failed` defect the deploySmoke tests once had). Use
   *  {@link start} only to *re*start after {@link kill}/{@link stop}. */
  static async launch(scratchDir: string): Promise<Gateway> {
    const bin = resolveServerBin();
    if (!bin) throw new Error("no gateway binary");
    rmSync(scratchDir, { recursive: true, force: true });
    const dataDir = join(scratchDir, "data");
    mkdirSync(dataDir, { recursive: true });
    const port = await freePort();
    const gw = new Gateway(bin, port, dataDir, scratchDir);
    await gw.start();
    return gw;
  }

  /** (Re)start the process against the same data dir + port — for restart-after-crash tests. */
  async start(): Promise<void> {
    // The child dups the fd for its stdio, so close our copy after spawn to
    // avoid leaking a descriptor per restart (ENFILE/EMFILE on long runs).
    const fd = openSync(join(this.logDir, `server-${++this.restarts}.log`), "a");
    try {
      this.proc = spawn(this.bin, [], {
        env: { ...process.env, PORT: String(this.port), NANOBPMN_DATA_DIR: this.dataDir },
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    await this.waitForTopology();
  }

  /** SIGKILL the process (a hard crash); the data dir is left intact. */
  kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }

  /** Wipe the journal — simulates a NON-durable engine (negative control). */
  wipeJournal(): void {
    rmSync(this.dataDir, { recursive: true, force: true });
    mkdirSync(this.dataDir, { recursive: true });
  }

  async stop(): Promise<void> {
    this.kill();
    await sleep(200);
  }

  private async waitForTopology(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/v2/topology`);
        if (res.status < 500) return;
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    throw new Error(`gateway did not come up within ${timeoutMs}ms`);
  }
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
