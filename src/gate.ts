import type { ReviewResult } from './schema.js';

/**
 * Deterministic gate: 0 = pass, 1 = block, like eslint. The verdict is already
 * derived from the findings' severity, failOn, and any ignore resolutions
 * (see deriveVerdict), so the gate simply reads it — one source of truth.
 */
export function gateExitCode(result: ReviewResult): 0 | 1 {
  return result.verdict === 'block' ? 1 : 0;
}
