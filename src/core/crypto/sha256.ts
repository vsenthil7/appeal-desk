/**
 * SHA-256, pure JavaScript. RFC 6234.
 *
 * Why pure JS and not `node:crypto` / WebCrypto: this module is imported by the
 * platform-free `core/` (no Node API surface) and must work identically inside
 * the Devvit sandbox, in vitest, and at the bench. WebCrypto is async; the
 * audit-chain code path is synchronous on the hot write path, so we want a
 * deterministic synchronous primitive. The implementation is the canonical
 * one (initial hash values, round constants, message schedule expansion).
 *
 * Used by:
 *   - `audit.ts` to chain-hash each `DecisionRecord` for tamper evidence (D8).
 *   - tests that recompute the chain for verification.
 *
 * Performance is irrelevant — we hash at most a few hundred bytes per decision.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

function utf8Encode(s: string): Uint8Array {
  // TextEncoder is in every modern runtime (Node 11+, Devvit, browsers).
  return new TextEncoder().encode(s);
}

/** SHA-256 of a UTF-8 string, returned as a lowercase hex digest. */
export function sha256Hex(input: string): string {
  const data = utf8Encode(input);
  const bitLen = BigInt(data.length) * 8n;

  // Pre-processing: pad to a multiple of 64 bytes; length appended as 64-bit BE.
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  // 8-byte big-endian message length, in bits.
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, bitLen, false);

  // Initial hash values (first 32 bits of the fractional parts of √2..√19).
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, w[t - 15]!) ^ rotr(18, w[t - 15]!) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(17, w[t - 2]!) ^ rotr(19, w[t - 2]!) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    h0.toString(16).padStart(8, '0') +
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h3.toString(16).padStart(8, '0') +
    h4.toString(16).padStart(8, '0') +
    h5.toString(16).padStart(8, '0') +
    h6.toString(16).padStart(8, '0') +
    h7.toString(16).padStart(8, '0')
  );
}
