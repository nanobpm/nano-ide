/**
 * Language-neutral hex helpers so the conformance corpus can express golden
 * frames as hex strings that any consumer (this repo, jwulf/c8ctl-plugin-nano,
 * a future non-JS client) can decode identically.
 */

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`invalid hex byte at index ${i * 2}`);
    }
    out[i] = Number.parseInt(pair, 16);
  }
  return out;
}
