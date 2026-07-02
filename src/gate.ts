import { type ReviewResult, type Severity, severityRank } from './schema.js';

/**
 * Deterministic gate: blocks when the reviewer says "block" or when any
 * finding reaches the failOn threshold. Like eslint: 0 = pass, 1 = block.
 */
export function gateExitCode(result: ReviewResult, failOn: Severity = 'blocker'): 0 | 1 {
  if (result.verdict === 'block') return 1;
  const threshold = severityRank(failOn);
  return result.findings.some((f) => severityRank(f.severity) >= threshold) ? 1 : 0;
}
