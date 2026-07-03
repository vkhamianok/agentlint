import { describe, expect, it } from 'vitest';

import { buildJsonReport } from '../../src/report/json.js';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import type { ReviewResult } from '../../src/schema.js';

const result: ReviewResult = {
  verdict: 'block',
  summary: 'One real bug.',
  findings: [
    {
      file: 'src/a.ts',
      line: 12,
      severity: 'blocker',
      title: 'Off-by-one in pagination',
      what: 'The loop stops one item early.',
      why: 'The last item of every page is dropped.',
      fixes: ['Use <= in the loop condition.', 'Or iterate with .slice(0, pageSize).'],
      confidence: 'high',
    },
    {
      file: 'src/b.ts',
      line: null,
      severity: 'info',
      title: 'Dead helper',
      what: 'unusedHelper is never called.',
      why: 'Dead code confuses future readers.',
      fixes: ['Delete it.'],
      confidence: 'medium',
    },
  ],
  questions: ['Should pagination be 0- or 1-based?'],
};

const meta = {
  target: 'commit HEAD',
  profile: 'deep',
  refutedCount: 2,
  cached: true,
  costUsd: 0.12,
  durationMs: 34_000,
};

describe('markdown report', () => {
  it('renders verdict, grouped findings, fixes, questions, and meta', () => {
    const md = renderMarkdownReport(result, meta);

    expect(md).toContain('# agentlint review: ✘ block');
    expect(md).toContain('Target: commit HEAD');
    expect(md).toContain('## Blockers');
    expect(md).toContain('### Off-by-one in pagination');
    expect(md).toContain('`src/a.ts:12`');
    expect(md).toContain('- **Fix:** Use <= in the loop condition.');
    expect(md).toContain('## Info');
    expect(md).toContain('`src/b.ts` _(confidence: medium)_');
    expect(md).toContain('## Questions');
    expect(md).toContain('$0.1200');
  });

  it('shows the profile badge and the refuted-findings note', () => {
    const md = renderMarkdownReport(result, meta);

    expect(md).toContain('2 finding(s) refuted by independent verification');
    expect(md).toContain('_cached · deep · 34.0s · $0.1200_');
  });
});

describe('json report', () => {
  it('is versioned and carries the full result plus meta', () => {
    const report = buildJsonReport(result, meta) as Record<string, unknown>;

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('block');
    expect(report.findings).toHaveLength(2);
    expect(report.target).toBe('commit HEAD');
    expect(report.profile).toBe('deep');
    expect(report.refutedCount).toBe(2);
    expect(report.cached).toBe(true); // agents must be able to tell a cached pass from a live one
    expect(report.costUsd).toBe(0.12);
    expect(typeof report.generatedAt).toBe('string');
  });
});
