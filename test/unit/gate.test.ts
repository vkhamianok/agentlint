import { describe, expect, it } from 'vitest';

import { gateExitCode } from '../../src/review/gate.js';
import type { ReviewResult } from '../../src/schema.js';

function result(verdict: ReviewResult['verdict']): ReviewResult {
  return { verdict, summary: 's', findings: [], questions: [] };
}

// The gate simply maps the (already derived) verdict to an exit code; the
// severity-vs-failOn and ignore-resolution logic lives in deriveVerdict.
describe('gateExitCode', () => {
  it('passes on a pass verdict', () => {
    expect(gateExitCode(result('pass'))).toBe(0);
  });

  it('blocks on a block verdict', () => {
    expect(gateExitCode(result('block'))).toBe(1);
  });
});
