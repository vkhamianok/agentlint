import type { ReviewResult } from '../schema.js';

export interface ReportMeta {
  target: string;
  costUsd?: number;
  durationMs?: number;
}

/** Stable machine-readable report shape; bump version on breaking changes. */
export function buildJsonReport(result: ReviewResult, meta: ReportMeta): object {
  return {
    version: 1,
    tool: 'agentlint',
    generatedAt: new Date().toISOString(),
    target: meta.target,
    verdict: result.verdict,
    summary: result.summary,
    findings: result.findings,
    questions: result.questions,
    costUsd: meta.costUsd,
    durationMs: meta.durationMs,
  };
}
