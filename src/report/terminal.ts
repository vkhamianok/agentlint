import pc from 'picocolors';

import type { ResolvedFinding, ReviewResult, Severity } from '../schema.js';

export interface RunMeta {
  costUsd?: number;
  durationMs?: number;
  profile?: string;
  refutedCount?: number;
  /** The verdict came from the cache, not a live run. */
  cached?: boolean;
  /** The run's cache key; shown so `ignore --run` has a handle. */
  runId?: string;
}

const severityLabel: Record<Severity, string> = {
  blocker: pc.red(pc.bold('BLOCKER')),
  warning: pc.yellow(pc.bold('WARNING')),
  info: pc.cyan(pc.bold('INFO')),
};

export function renderTerminalReport(result: ReviewResult, meta: RunMeta = {}): string {
  const lines: string[] = [];

  const verdict =
    result.verdict === 'pass' ? pc.green(pc.bold('✔ PASS')) : pc.red(pc.bold('✘ BLOCK'));
  lines.push('', `${verdict}  ${result.summary}`, '');

  const counts = (['blocker', 'warning', 'info'] as const)
    .map((s) => ({ s, n: result.findings.filter((f) => f.severity === s).length }))
    .filter(({ n }) => n > 0)
    .map(({ s, n }) => `${n} ${s}${n === 1 ? '' : 's'}`)
    .join(', ');
  if (counts) lines.push(pc.bold(counts), '');

  const bySeverity: Severity[] = ['blocker', 'warning', 'info'];
  for (const severity of bySeverity) {
    for (const finding of result.findings.filter((f) => f.severity === severity)) {
      lines.push(...renderFinding(finding), '');
    }
  }

  if (result.questions.length > 0) {
    lines.push(pc.bold('Questions for you:'));
    for (const q of result.questions) lines.push(`  ? ${q}`);
    lines.push('');
  }

  if (meta.refutedCount) {
    lines.push(
      pc.dim(
        `${meta.refutedCount} finding${meta.refutedCount === 1 ? '' : 's'} refuted by independent verification and dropped.`,
      ),
      '',
    );
  }

  const metaParts: string[] = [];
  if (meta.cached) metaParts.push('cached');
  if (meta.profile) metaParts.push(meta.profile);
  if (meta.durationMs !== undefined) metaParts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta.costUsd !== undefined) metaParts.push(`$${meta.costUsd.toFixed(4)}`);
  if (metaParts.length > 0) lines.push(pc.dim(metaParts.join('  ·  ')));

  if (result.findings.length > 0 && meta.runId) {
    lines.push(
      pc.dim(
        `Dismiss a false positive: agentlint ignore <id> "reason"   ·   run ${meta.runId.slice(0, 12)}`,
      ),
    );
  }

  return lines.join('\n');
}

function renderFinding(f: ResolvedFinding): string[] {
  const id = pc.dim(`[${f.id}]`);
  if (f.resolution.state === 'ignored') {
    const reason = f.resolution.reason ? `: ${f.resolution.reason}` : '';
    return [pc.dim(`— ${f.severity} ${f.title} ${id} (ignored${reason})`)];
  }
  const location = f.line === null ? f.file : `${f.file}:${f.line}`;
  const confidence = f.confidence === 'high' ? '' : pc.dim(` (confidence: ${f.confidence})`);
  const lines = [
    `${severityLabel[f.severity]}  ${pc.bold(f.title)}${confidence}  ${id}`,
    `  ${pc.underline(location)}`,
    `  ${f.what}`,
    `  ${pc.dim('why:')} ${f.why}`,
  ];
  for (const fix of f.fixes) {
    lines.push(`  ${pc.green('fix:')} ${fix}`);
  }
  return lines;
}
