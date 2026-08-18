// SCAFFOLD PLACEHOLDER — no-op PII check so `check:pii` is GREEN on the empty
// scaffold. The S6 PII CI slice (s6-pii-ci) REPLACES this file with the real
// layout-aware classification that walks the S3 git layout, reuses the S6-core
// classifier from @nanobpm/urban/context/pii, and exits non-zero on a violation.
//
// The `check:pii` script is already pre-declared in packages/urban/package.json
// by the scaffold; the S6 CI slice fills THIS file and does NOT edit the manifest.
//
// Run with: node --experimental-strip-types scripts/check-pii.ts
console.log("check:pii — scaffold placeholder (no records to scan); replaced by slice s6-pii-ci.");
process.exit(0);
