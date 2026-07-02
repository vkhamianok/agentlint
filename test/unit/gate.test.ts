import { describe, expect, it } from 'vitest';

import { gateExitCode } from '../../src/gate.js';
import type { Finding, ReviewResult } from '../../src/schema.js';

function finding(severity: Finding['severity']): Finding {
  return {
    file: 'a.ts',
    line: 1,
    severity,
    title: 't',
    what: 'w',
    why: 'y',
    fixes: ['f'],
    confidence: 'high',
  };
}

function result(verdict: ReviewResult['verdict'], findings: Finding[]): ReviewResult {
  return { verdict, summary: 's', findings, questions: [] };
}

describe('gateExitCode', () => {
  it('passes a clean review', () => {
    expect(gateExitCode(result('pass', []))).toBe(0);
  });

  it('blocks when the verdict is block, regardless of findings', () => {
    expect(gateExitCode(result('block', []))).toBe(1);
  });

  it('blocks on a blocker finding even with a pass verdict', () => {
    expect(gateExitCode(result('pass', [finding('blocker')]))).toBe(1);
  });

  it('lets warnings through at the default threshold', () => {
    expect(gateExitCode(result('pass', [finding('warning'), finding('info')]))).toBe(0);
  });

  it('blocks warnings when failOn is lowered', () => {
    expect(gateExitCode(result('pass', [finding('warning')]), 'warning')).toBe(1);
  });
});
