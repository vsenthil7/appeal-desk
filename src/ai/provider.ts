/**
 * Optional AI layer — ASSISTIVE, NEVER DECISIVE.
 *
 * Two jobs, both suggestions only:
 *   1. triage(): label an appeal "likely genuine / duplicate / abusive" to help
 *      a mod PRIORITISE. It never bans, unbans, or auto-decides.
 *   2. softenReply(): draft a calmer, more respectful version of a templated
 *      reply that the mod can EDIT before sending.
 *
 * Crucial design rule: the whole app must work end-to-end with this layer
 * switched off. So this module is built around an interface with a real
 * implementation AND a no-op fallback. When `aiEnabled` is false (or no model
 * is wired up), callers transparently get the no-op, which returns nothing /
 * the original text. Nothing downstream changes behaviour.
 */

import type { Appeal } from '../core/types.js';

/** Result of an AI triage pass. Mirrors `TriageHint.model`. */
export interface AiTriageResult {
  label: 'likely_genuine' | 'likely_duplicate' | 'likely_abusive';
  confidence: number; // 0..1
  rationale: string;
}

/** The capability surface. Anything that satisfies this can be the AI backend. */
export interface AiProvider {
  triage(appeal: Appeal): Promise<AiTriageResult | null>;
  softenReply(draft: string, appeal: Appeal): Promise<string>;
}

/**
 * No-op provider. This is what you get when AI is disabled. It is a first-class
 * part of the design, not a stub: it guarantees the "if no AI at all" path is
 * always exercised and always coherent.
 */
export class NoopAiProvider implements AiProvider {
  async triage(): Promise<AiTriageResult | null> {
    return null; // no hint; the deterministic dedup signal still stands
  }
  async softenReply(draft: string): Promise<string> {
    return draft; // mods send the static template unchanged
  }
}

/**
 * A thin model-backed provider. In Devvit, in-platform text generation is
 * reached through an injected `generateText` function (kept abstract here so
 * the core stays free of platform imports and stays unit-testable). The
 * provider does all the prompt-shaping and, importantly, all the SAFETY
 * clamping — it can only ever produce a label + rationale, never an action.
 */
export class ModelAiProvider implements AiProvider {
  constructor(
    private readonly generateText: (prompt: string) => Promise<string>,
  ) {}

  async triage(appeal: Appeal): Promise<AiTriageResult | null> {
    const prompt = buildTriagePrompt(appeal);
    let raw: string;
    try {
      raw = await this.generateText(prompt);
    } catch {
      return null; // model failure must never block the mod — degrade silently
    }
    return parseTriage(raw);
  }

  async softenReply(draft: string, appeal: Appeal): Promise<string> {
    const prompt = buildSoftenPrompt(draft, appeal);
    try {
      const out = (await this.generateText(prompt)).trim();
      // Guard: never return empty / absurdly long output; fall back to the draft.
      if (out.length === 0 || out.length > draft.length * 4) return draft;
      return out;
    } catch {
      return draft;
    }
  }
}

/** Pick the right provider given the sub's setting and an optional backend. */
export function selectProvider(
  aiEnabled: boolean,
  backend?: AiProvider,
): AiProvider {
  if (aiEnabled && backend) return backend;
  return new NoopAiProvider();
}

// ---- prompt construction & parsing (pure, testable) --------------------

export function buildTriagePrompt(appeal: Appeal): string {
  return [
    'You are assisting a Reddit moderator by TRIAGING an appeal.',
    'You do NOT make decisions. Output ONLY a JSON object with keys',
    '"label" (one of likely_genuine|likely_duplicate|likely_abusive),',
    '"confidence" (0..1), and "rationale" (one short sentence).',
    '',
    `Action appealed: ${appeal.actionType}`,
    `Prior appeals by this user in this sub: ${appeal.triage.repeatCount}`,
    `Deterministic duplicate match: ${
      appeal.triage.duplicateOfAppealId ? 'yes' : 'no'
    }`,
    `Original removal reason: ${appeal.originalReason}`,
    `User acknowledged the rule: ${appeal.acknowledged ? 'yes' : 'no'}`,
    `Appeal text: """${appeal.reason}"""`,
  ].join('\n');
}

export function buildSoftenPrompt(draft: string, appeal: Appeal): string {
  return [
    'Rewrite the following moderator reply to be calm, respectful and clear,',
    'WITHOUT changing the decision it conveys or adding promises. Keep it short.',
    'Do not invent facts. Output only the rewritten reply, no preamble.',
    '',
    `Decision context (action: ${appeal.actionType}).`,
    `Reply to rewrite: """${draft}"""`,
  ].join('\n');
}

/**
 * Parse the model's triage JSON defensively. Any malformed output yields null
 * (no hint) rather than throwing — the mod is never blocked by a bad response.
 */
export function parseTriage(raw: string): AiTriageResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const label = obj.label;
    if (
      label !== 'likely_genuine' &&
      label !== 'likely_duplicate' &&
      label !== 'likely_abusive'
    ) {
      return null;
    }
    const confidence = clamp01(Number(obj.confidence));
    const rationale =
      typeof obj.rationale === 'string'
        ? obj.rationale.slice(0, 240)
        : '';
    return { label, confidence, rationale };
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
