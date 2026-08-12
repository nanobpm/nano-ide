# @nanobpm/agentic-protocol

The wire contract and shared conformance corpus for the **Nano agentic
protocol** (ADR 0056) — one app-tier channel (served by the app on its own
bound port) carrying agent presence/registry, demand×supply, the blackboard and
live terminal relay.

This package is **slice S0** of epic
[nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124): the
single source of truth every other slice — and the cross-repo c8ctl client
(jwulf/c8ctl-plugin-nano#38) — keys off. It ships no runtime server; it defines
the contract and the adversarial vectors that keep independent implementations
from drifting.

## What's here

- **Message families** (`MESSAGE_FAMILIES`) — the canonical, named set
  (`register` / `heartbeat` / `deregister`, `serve`, `demand`, `blackboard`,
  `relay`). Every family module and S1's `registerFamilyHandler` seam key off
  this one constant.
- **Frame codec** (`encodeFrame` / `decodeFrame`) — a compact binary envelope
  carrying a QoS lane, a family, a `uint32` sequence number, and a
  JSON-serialisable payload. Decoding rejects malformed input with a typed
  `FrameDecodeError.code`.
- **Three QoS lanes** (`QOS_LANES`) — `control` > `interactive` > `bulk`, in
  strict priority order, plus `compareFrameOrder`, the scheduler ordering that
  guarantees a bulk-output storm never head-of-line-blocks a heartbeat or a
  blackboard write.
- **Routing-token grammar** (`parseToken`) — `network[.subnetwork…].role[#seat]`.
  Capability (cognition/weight/family/host) is **never** in the token; it is an
  enrolment attribute and a registry gate.
- **Vocab-artifact schema** (`validateVocabDocument`) — the versioned
  capability→token map (core + author extension in the same schema), with
  per-role `requires` / `weight` / `seats` / `seatsDistinctFamily`.
- **Per-family payload contracts** (`validatePayload`).

## The conformance corpus

`@nanobpm/agentic-protocol/conformance` exports golden frames (frame ↔ exact
wire hex, both directions, boundary values), malformed byte vectors paired with
their expected rejection code, and vocab/token valid+invalid vectors. Both this
repo's codec and the c8ctl client are held to it:

```ts
import { decodeFrame, encodeFrame, bytesToHex, hexToBytes } from "@nanobpm/agentic-protocol";
import { GOLDEN_FRAMES, MALFORMED_FRAMES } from "@nanobpm/agentic-protocol/conformance";

for (const g of GOLDEN_FRAMES) {
  assert.equal(bytesToHex(encodeFrame(g.frame)), g.hex);   // encode is canonical
  assert.deepEqual(decodeFrame(hexToBytes(g.hex)), g.frame); // round-trips
}
for (const m of MALFORMED_FRAMES) {
  assert.throws(() => decodeFrame(hexToBytes(m.hex)), (e) => e.code === m.expected);
}
```

Corpus completeness is itself tested (`src/conformance/corpus.test.ts`): adding a
family, lane, or decode-error code without a covering vector fails CI.

## Wire format

All integers big-endian, unsigned:

| offset | size | field                                        |
| -----: | ---: | -------------------------------------------- |
|      0 |    2 | magic `0x4E41` ("NA")                        |
|      2 |    1 | version (`1`)                                |
|      3 |    1 | lane code (`0`=control, `1`=interactive, `2`=bulk) |
|      4 |    1 | family code (`1`..`7`)                       |
|      5 |    4 | seq (`uint32`)                               |
|      9 |    4 | payload length (`uint32`)                    |
|     13 |    N | payload (UTF-8 JSON)                          |

Codes are part of the contract and are never renumbered; append only.

## Scripts

```bash
npm run build -w @nanobpm/agentic-protocol       # tsc -> dist
npm run typecheck -w @nanobpm/agentic-protocol   # tsc --noEmit
npm run test -w @nanobpm/agentic-protocol        # node --test
```
