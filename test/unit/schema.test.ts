import { describe, expect, it } from 'vitest';

import {
  type Finding,
  deriveVerdict,
  reviewerOutputJsonSchema,
  reviewerOutputSchema,
} from '../../src/schema.js';

const valid = {
  summary: 'One bug found.',
  findings: [
    {
      file: 'src/a.ts',
      line: 12,
      severity: 'blocker',
      title: 'Off-by-one in pagination',
      what: 'The loop stops one item early.',
      why: 'The last item of every page is silently dropped.',
      fixes: ['Use <= instead of < in the loop condition.'],
      confidence: 'high',
    },
  ],
  questions: [],
};

describe('reviewerOutputSchema', () => {
  it('accepts a well-formed reviewer output', () => {
    expect(reviewerOutputSchema.safeParse(valid).success).toBe(true);
  });

  it('tolerates extra keys from the model instead of failing the review', () => {
    const withExtras = {
      ...valid,
      reviewer_notes: 'extra top-level key',
      findings: [{ ...valid.findings[0], suggestion: 'extra finding key' }],
    };
    expect(reviewerOutputSchema.safeParse(withExtras).success).toBe(true);
  });

  it('rejects a finding without fixes', () => {
    const noFixes = {
      ...valid,
      findings: [{ ...valid.findings[0], fixes: [] }],
    };
    expect(reviewerOutputSchema.safeParse(noFixes).success).toBe(false);
  });

  it('rejects unknown severities', () => {
    const bad = {
      ...valid,
      findings: [{ ...valid.findings[0], severity: 'catastrophic' }],
    };
    expect(reviewerOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('exports a CLI JSON Schema WITHOUT verdict — the reviewer no longer authors it', () => {
    const json = reviewerOutputJsonSchema as { required?: string[] };
    expect(json.required).toEqual(expect.arrayContaining(['summary', 'findings', 'questions']));
    expect(json.required).not.toContain('verdict');
  });

  it('strips the $schema key that breaks StructuredOutput in claude CLI 2.1.198', () => {
    expect(reviewerOutputJsonSchema).not.toHaveProperty('$schema');
  });
});

describe('deriveVerdict', () => {
  const finding = (severity: Finding['severity']): Finding => ({
    file: 'a.ts',
    line: 1,
    severity,
    title: 't',
    what: 'w',
    why: 'y',
    fixes: ['f'],
    confidence: 'high',
  });

  it('blocks when a finding reaches the failOn threshold, passes otherwise', () => {
    expect(deriveVerdict([finding('blocker')], 'blocker')).toBe('block');
    expect(deriveVerdict([finding('warning')], 'blocker')).toBe('pass'); // the README case
    expect(deriveVerdict([finding('warning')], 'warning')).toBe('block');
    expect(deriveVerdict([], 'info')).toBe('pass');
  });
});
