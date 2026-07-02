import { describe, expect, it } from 'vitest';

import { reviewResultJsonSchema, reviewResultSchema } from '../../src/schema.js';

const valid = {
  verdict: 'block',
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

describe('reviewResultSchema', () => {
  it('accepts a well-formed result', () => {
    expect(reviewResultSchema.safeParse(valid).success).toBe(true);
  });

  it('tolerates extra keys from the model instead of failing the review', () => {
    const withExtras = {
      ...valid,
      reviewer_notes: 'extra top-level key',
      findings: [{ ...valid.findings[0], suggestion: 'extra finding key' }],
    };
    expect(reviewResultSchema.safeParse(withExtras).success).toBe(true);
  });

  it('rejects a finding without fixes', () => {
    const noFixes = {
      ...valid,
      findings: [{ ...valid.findings[0], fixes: [] }],
    };
    expect(reviewResultSchema.safeParse(noFixes).success).toBe(false);
  });

  it('rejects unknown severities', () => {
    const bad = {
      ...valid,
      findings: [{ ...valid.findings[0], severity: 'catastrophic' }],
    };
    expect(reviewResultSchema.safeParse(bad).success).toBe(false);
  });

  it('exports a JSON Schema for the CLI with the same required fields', () => {
    const json = reviewResultJsonSchema as { required?: string[] };
    expect(json.required).toEqual(
      expect.arrayContaining(['verdict', 'summary', 'findings', 'questions']),
    );
  });

  it('strips the $schema key that breaks StructuredOutput in claude CLI 2.1.198', () => {
    expect(reviewResultJsonSchema).not.toHaveProperty('$schema');
  });
});
