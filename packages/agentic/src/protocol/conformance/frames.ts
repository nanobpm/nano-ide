import type { Frame } from "../frame.ts";

/** The channels a golden frame may travel on. Single source of truth for the
 * direction contract — the corpus completeness test derives its coverage from
 * this union so a new variant cannot be added without a covering vector. */
export type FrameDirection = "worker->hub" | "hub->worker" | "hub->observers";

/**
 * Golden frame vectors: canonical (frame ↔ bytes) pairs the codec must satisfy
 * in BOTH directions. `hex` is the exact wire encoding of `frame`. These are
 * committed goldens — a codec change that alters the wire bytes fails the
 * round-trip test, catching drift between this repo and the c8ctl client.
 *
 * Coverage spans every message family, every QoS lane, both directions, and
 * boundary values (seq = 0, seq = uint32 max, null payload, empty string,
 * multi-byte UTF-8).
 */
export interface GoldenFrame {
  readonly name: string;
  /** Informational: which way the frame travels on the channel. */
  readonly direction: FrameDirection;
  readonly frame: Frame;
  /** Exact wire encoding of `frame`, as a lowercase hex string. */
  readonly hex: string;
}

export const GOLDEN_FRAMES: readonly GoldenFrame[] = [
  {
    name: "register-worker-to-hub",
    direction: "worker->hub",
    frame: {
      lane: "control",
      family: "register",
      seq: 1,
      payload: {
        instance: "w-abc123",
        capability: { cognition: "opus", weight: 3, family: "anthropic", host: "mac-01" },
      },
    },
    hex: "4e4101000100000001000000697b22696e7374616e6365223a22772d616263313233222c226361706162696c697479223a7b22636f676e6974696f6e223a226f707573222c22776569676874223a332c2266616d696c79223a22616e7468726f706963222c22686f7374223a226d61632d3031227d7d",
  },
  {
    name: "heartbeat-seq-zero",
    direction: "worker->hub",
    frame: { lane: "control", family: "heartbeat", seq: 0, payload: { instance: "w-abc123" } },
    hex: "4e4101000200000000000000177b22696e7374616e6365223a22772d616263313233227d",
  },
  {
    name: "deregister-with-reason",
    direction: "worker->hub",
    frame: {
      lane: "control",
      family: "deregister",
      seq: 42,
      payload: { instance: "w-abc123", reason: "shutdown" },
    },
    hex: "4e410100030000002a0000002b7b22696e7374616e6365223a22772d616263313233222c22726561736f6e223a2273687574646f776e227d",
  },
  {
    name: "serve-hub-to-worker",
    direction: "hub->worker",
    frame: {
      lane: "control",
      family: "serve",
      seq: 2,
      payload: { instance: "w-abc123", tokens: ["implementation.qa.red#1", "planning.decide"] },
    },
    hex: "4e41010004000000020000004e7b22696e7374616e6365223a22772d616263313233222c22746f6b656e73223a5b22696d706c656d656e746174696f6e2e71612e7265642331222c22706c616e6e696e672e646563696465225d7d",
  },
  {
    name: "demand-hub-to-observers",
    direction: "hub->observers",
    frame: {
      lane: "control",
      family: "demand",
      seq: 7,
      payload: { network: "implementation", missing: ["implementation.ci"] },
    },
    hex: "4e41010005000000070000003c7b226e6574776f726b223a22696d706c656d656e746174696f6e222c226d697373696e67223a5b22696d706c656d656e746174696f6e2e6369225d7d",
  },
  {
    name: "blackboard-append-interactive",
    direction: "worker->hub",
    frame: {
      lane: "interactive",
      family: "blackboard",
      seq: 100,
      payload: { op: "append", dedupeKey: "regen-before-build" },
    },
    hex: "4e4101010600000064000000307b226f70223a22617070656e64222c226465647570654b6579223a22726567656e2d6265666f72652d6275696c64227d",
  },
  {
    name: "blackboard-read-interactive",
    direction: "worker->hub",
    frame: {
      lane: "interactive",
      family: "blackboard",
      seq: 101,
      payload: { op: "read", since: 12 },
    },
    hex: "4e4101010600000065000000187b226f70223a2272656164222c2273696e6365223a31327d",
  },
  {
    name: "relay-produce-bulk",
    direction: "worker->hub",
    frame: {
      lane: "bulk",
      family: "relay",
      seq: 5,
      payload: { op: "produce", stream: "job-1223", incarnation: 1, chunk: "hello world\n" },
    },
    hex: "4e41010207000000050000004c7b226f70223a2270726f64756365222c2273747265616d223a226a6f622d31323233222c22696e6361726e6174696f6e223a312c226368756e6b223a2268656c6c6f20776f726c645c6e227d",
  },
  {
    name: "relay-subscribe-control",
    direction: "worker->hub",
    frame: {
      lane: "control",
      family: "relay",
      seq: 6,
      payload: { op: "subscribe", stream: "job-1223", from: 0, credit: 1024 },
    },
    hex: "4e41010007000000060000003d7b226f70223a22737562736372696265222c2273747265616d223a226a6f622d31323233222c2266726f6d223a302c22637265646974223a313032347d",
  },
  {
    name: "relay-credit-control",
    direction: "worker->hub",
    frame: { lane: "control", family: "relay", seq: 7, payload: { op: "credit", credit: 512 } },
    hex: "4e41010007000000070000001c7b226f70223a22637265646974222c22637265646974223a3531327d",
  },
  {
    name: "relay-subscribed-ack-control",
    direction: "hub->worker",
    frame: {
      lane: "control",
      family: "relay",
      seq: 8,
      payload: { op: "subscribed", stream: "job-1223", gap: false, nextOffset: 2048 },
    },
    hex: "4e4101000700000008000000457b226f70223a2273756273637269626564222c2273747265616d223a226a6f622d31323233222c22676170223a66616c73652c226e6578744f6666736574223a323034387d",
  },
  {
    name: "relay-seq-max-bulk",
    direction: "hub->worker",
    frame: {
      lane: "bulk",
      family: "relay",
      seq: 4294967295,
      payload: { stream: "job-1223", offset: 0, chunk: "" },
    },
    hex: "4e41010207ffffffff0000002b7b2273747265616d223a226a6f622d31323233222c226f6666736574223a302c226368756e6b223a22227d",
  },
  {
    name: "null-payload-envelope",
    direction: "hub->worker",
    frame: { lane: "control", family: "heartbeat", seq: 3, payload: null },
    hex: "4e4101000200000003000000046e756c6c",
  },
  {
    name: "unicode-payload-relay",
    direction: "hub->worker",
    frame: {
      lane: "bulk",
      family: "relay",
      seq: 9,
      payload: { stream: "job-1223", offset: 4, chunk: "✓ café — 日本語" },
    },
    hex: "4e4101020700000009000000427b2273747265616d223a226a6f622d31323233222c226f6666736574223a342c226368756e6b223a22e29c9320636166c3a920e2809420e697a5e69cace8aa9e227d",
  },
];
