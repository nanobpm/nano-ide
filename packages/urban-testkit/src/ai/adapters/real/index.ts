// PLACEHOLDER owned by slice S4 (real, opt-in adapters). Created by S1; S4 replaces this
// whole file.
//
// IMPORT-SAFETY CONTRACT (critical — S4 MUST preserve this): the `/ai` barrel eagerly
// imports this module on the default Node lane AND the Deno lane (`npm run test:deno`),
// where the optional/heavy real-adapter dependencies may be ABSENT or unresolvable.
// Therefore this module MUST be import-safe:
//   (i)   NO top-level `import` of any optional/heavy dependency;
//   (ii)  NO network I/O at import;
//   (iii) NO real-backend instantiation at import;
//   (iv)  NO opt-in env/flag required merely to be imported.
//
// At module top-level S4 may ONLY: register static real-seam descriptors via
// `registerRealSeamDescriptor({ seam, docRef })` (a pure static fact — no instantiation,
// no opt-in, no network) and declare construction factory functions. The optional deps
// must be loaded LAZILY via dynamic `import()` INSIDE the opt-in-gated construction path.
//
// In slice S1 this placeholder registers NO descriptor (so `seamInventory().hasReal`
// stays false for both seams) and only exposes a throwing factory.

/** Placeholder: S4 constructs the real adapters here, gated behind explicit opt-in. */
export function createRealAdapters(): never {
  throw new Error("real AI adapters are not enabled/implemented yet (slice S4)");
}
