/**
 * Audit-chain helpers (D8).
 *
 * The THREAT_MODEL §3 lists "Repudiation" as an accepted risk because the audit
 * trail isn't independently signed. A *minimal* upgrade that closes most of the
 * gap for free: each `DecisionRecord` carries a `chainHash` =
 * `sha256(prevChainHash + canonicalize(thisRecord))`, where `prevChainHash` is
 * the previous record's hash (or the empty string for the first record).
 *
 * A later export can prove the audit trail wasn't silently edited by
 * recomputing every hash from the canonical record. The chain stays inside the
 * appeal record — no new storage — and `verifyChain` is a pure function over
 * the appeal, so tests, an export, or a future operator UI can all use it.
 *
 * This is NOT a replacement for an external signed log; it closes the
 * "in-place tampering" attack, not the "we deleted the whole record" attack.
 * That's an honest, useful improvement, documented as such.
 */

import type { Appeal, DecisionRecord } from './types.js';
import { sha256Hex } from './crypto/sha256.js';

/**
 * Canonical JSON of the chain-evident fields. We deliberately include the
 * `decidedAt`/`modId`/`decision`/`note`/`replyText`/`decision`/`modName`
 * fields and EXCLUDE `chainHash` itself (so a record's hash doesn't depend on
 * itself), in a stable key order. JSON.stringify is deterministic for a
 * fixed-shape object — we build the object explicitly so a future shape
 * change to `DecisionRecord` doesn't silently invalidate every prior hash.
 */
export function canonicalize(record: Omit<DecisionRecord, 'chainHash'>): string {
  return JSON.stringify({
    decidedAt: record.decidedAt,
    decision: record.decision,
    modId: record.modId,
    modName: record.modName,
    note: record.note,
    replyText: record.replyText,
  });
}

/**
 * Compute the chain hash for a new decision given the previous record's hash.
 * `prevChainHash` should be the empty string for the first record.
 */
export function computeChainHash(
  prevChainHash: string,
  record: Omit<DecisionRecord, 'chainHash'>,
): string {
  return sha256Hex(prevChainHash + canonicalize(record));
}

/**
 * Verify that every `chainHash` in an appeal's audit trail is consistent with
 * the record it tags. Records that pre-date the chainHash field (i.e. older
 * persisted appeals) are accepted as a back-compat carve-out: a missing hash
 * isn't a tamper, it's a legacy record. Once a record has any hash, every
 * subsequent record must too — gaps in the middle are tampering.
 *
 * Returns `{ ok: true }` if verified, `{ ok: false, at: index, reason }`
 * otherwise so callers can surface a precise message.
 */
export function verifyChain(
  appeal: Appeal,
):
  | { ok: true }
  | { ok: false; at: number; reason: 'mismatch' | 'gap_after_hash' } {
  let prev = '';
  let hashStarted = false;
  for (let i = 0; i < appeal.decisions.length; i++) {
    const d = appeal.decisions[i]!;
    if (d.chainHash === undefined) {
      if (hashStarted) {
        return { ok: false, at: i, reason: 'gap_after_hash' };
      }
      continue;
    }
    hashStarted = true;
    const expected = computeChainHash(prev, d);
    if (expected !== d.chainHash) {
      return { ok: false, at: i, reason: 'mismatch' };
    }
    prev = d.chainHash;
  }
  return { ok: true };
}
