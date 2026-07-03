import type { Finding, ReviewResult, Severity } from '../schema.js';
import type { ReportMeta } from './json.js';

const severityHeading: Record<Severity, string> = {
  blocker: 'Blockers',
  warning: 'Warnings',
  info: 'Info',
};

export function renderMarkdownReport(result: ReviewResult, meta: ReportMeta): string {
  const lines: string[] = [
    `# agentlint review: ${result.verdict === 'pass' ? '✔ pass' : '✘ block'}`,
    '',
    `Target: ${meta.target}`,
    '',
    result.summary,
  ];

  for (const severity of ['blocker', 'warning', 'info'] as const) {
    const findings = result.findings.filter((f) => f.severity === severity);
    if (findings.length === 0) continue;
    lines.push('', `## ${severityHeading[severity]}`);
    for (const finding of findings) lines.push('', ...renderFinding(finding));
  }

  if (result.questions.length > 0) {
    lines.push('', '## Questions');
    for (const q of result.questions) lines.push('', `- ${q}`);
  }

  if (meta.refutedCount) {
    lines.push(
      '',
      `_${meta.refutedCount} finding(s) refuted by independent verification and dropped._`,
    );
  }

  const metaParts: string[] = [];
  if (meta.cached) metaParts.push('cached');
  if (meta.profile) metaParts.push(meta.profile);
  if (meta.durationMs !== undefined) metaParts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta.costUsd !== undefined) metaParts.push(`$${meta.costUsd.toFixed(4)}`);
  if (metaParts.length > 0) lines.push('', '---', '', `_${metaParts.join(' · ')}_`);

  return lines.join('\n') + '\n';
}

function renderFinding(f: Finding): string[] {
  const location = f.line === null ? f.file : `${f.file}:${f.line}`;
  const lines = [
    `### ${f.title}`,
    '',
    `\`${location}\`${f.confidence === 'high' ? '' : ` _(confidence: ${f.confidence})_`}`,
    '',
    f.what,
    '',
    `**Why it matters:** ${f.why}`,
    '',
  ];
  for (const fix of f.fixes) lines.push(`- **Fix:** ${fix}`);
  return lines;
}
