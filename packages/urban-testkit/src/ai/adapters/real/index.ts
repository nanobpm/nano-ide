// Real, opt-in adapters behind the S1 seams (issue #297, slice S4). This file REPLACES the
// S1 placeholder and is eagerly imported by the `/ai` barrel on the default Node lane AND
// the Deno lane (`npm run test:deno`).
//
// IMPORT-SAFETY CONTRACT (preserved from S1 — do not break):
//   (i)   NO top-level `import` of any optional/heavy dependency (`openai`,
//         `@xenova/transformers`); those load LAZILY via dynamic `import()` inside the
//         opt-in-gated construction factories (see ./hosted.ts, ./local.ts, ./env.ts).
//   (ii)  NO network I/O at import.
//   (iii) NO real-backend instantiation at import.
//   (iv)  NO opt-in env/flag required merely to be imported.
// At module top-level we ONLY register the STATIC real-seam descriptors (a pure fact — no
// instantiation, no opt-in, no network) and re-export construction factories.
//
// STATIC EXISTENCE vs LIVE ACTIVATION:
//   - STATIC: the two `registerRealSeamDescriptor` calls below run UNCONDITIONALLY at
//     import, so `seamInventory()` reports `hasReal: true` + a `docRef` for BOTH seams on
//     the default no-opt-in, network-free path. This is what S5's completeness guard checks.
//   - LIVE: actually constructing/selecting a real adapter (and thus loading an optional
//     dependency and hitting the network) happens ONLY when `URBAN_TESTKIT_AI_REAL` is set
//     (blackboard contract `env:URBAN_TESTKIT_AI_REAL`); otherwise the factories throw.

import { registerRealSeamDescriptor } from "../../inventory.ts";

/** docRef for the real embedding backends (hosted + local). */
const EMBEDDING_REAL_DOC_REF =
  "packages/urban-testkit/README.md#real-ai-adapters — EmbeddingModelAdapter: " +
  "HostedEmbeddingAdapter (src/ai/adapters/real/hosted.ts), LocalEmbeddingAdapter (src/ai/adapters/real/local.ts)";

/** docRef for the real chat/judge backends (hosted + local; optional image = vision). */
const CHAT_REAL_DOC_REF =
  "packages/urban-testkit/README.md#real-ai-adapters — ChatModelAdapter: " +
  "HostedChatModelAdapter (src/ai/adapters/real/hosted.ts), LocalChatModelAdapter (src/ai/adapters/real/local.ts)";

// STATIC, unconditional at import — flips `seamInventory().hasReal` true for BOTH seams on
// the default path. No instantiation, no opt-in, no network.
registerRealSeamDescriptor({ seam: "EmbeddingModelAdapter", docRef: EMBEDDING_REAL_DOC_REF });
registerRealSeamDescriptor({ seam: "ChatModelAdapter", docRef: CHAT_REAL_DOC_REF });

// Opt-in gate (LIVE activation).
export { REAL_AI_OPT_IN_ENV, isRealAiEnabled, assertRealAiEnabled } from "./env.ts";

// Provider-selection factories (opt-in gated, lazy optional-dep import).
export {
  type RealAdapterOptions,
  type RealAdapterPair,
  type RealProvider,
  createRealAdapters,
  createRealChatModelAdapter,
  createRealEmbeddingAdapter,
} from "./factory.ts";

// Hosted-provider backend (both seams).
export {
  HostedChatModelAdapter,
  HostedEmbeddingAdapter,
  type HostedProviderConfig,
  createHostedProviderAdapters,
} from "./hosted.ts";

// Local / on-device backend (both seams).
export {
  LocalChatModelAdapter,
  LocalEmbeddingAdapter,
  type LocalModelConfig,
  createLocalModelAdapters,
} from "./local.ts";

// Record-mode capture-from-live helpers (via S1's pluggable capture-source injection point).
export {
  type RecordFromLiveOptions,
  createRecordingChatModelAdapter,
  createRecordingEmbeddingAdapter,
} from "./capture.ts";
