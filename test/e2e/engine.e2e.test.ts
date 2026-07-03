import { describe, expect, it } from 'vitest';

import { runClaude } from '../../src/engine/claude.js';

// Costs real money: runs only with AGENTLINT_E2E=1.
describe.skipIf(!process.env.AGENTLINT_E2E)('engine e2e (real claude CLI)', () => {
  it('returns schema-validated structured output', { timeout: 120_000 }, async () => {
    const envelope = await runClaude({
      prompt:
        'This is a plumbing test of structured output. ' +
        "Return a verdict of 'pass', a one-sentence summary saying this is a test, " +
        'an empty findings array, and an empty questions array.',
      jsonSchema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['pass', 'block'] },
          summary: { type: 'string' },
          findings: { type: 'array', items: { type: 'object' } },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['verdict', 'summary', 'findings', 'questions'],
      },
      tools: [],
      model: 'haiku',
      timeoutMs: 110_000,
    });

    expect(envelope.is_error).toBe(false);
    const output = envelope.structured_output as { verdict: string; findings: unknown[] };
    expect(output.verdict).toBe('pass');
    expect(output.findings).toEqual([]);
  });

  it('streams live steps and still returns structured output', { timeout: 180_000 }, async () => {
    const steps: string[] = [];
    const envelope = await runClaude({
      prompt:
        'Use the Glob tool to list files, then Read one file, then call StructuredOutput ' +
        "with a verdict of 'pass', a one-sentence summary, an empty findings array, and " +
        'an empty questions array.',
      jsonSchema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['pass', 'block'] },
          summary: { type: 'string' },
          findings: { type: 'array', items: { type: 'object' } },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['verdict', 'summary', 'findings', 'questions'],
      },
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku',
      cwd: process.cwd(),
      timeoutMs: 170_000,
      onStep: (s) => steps.push(s),
    });

    // The streaming path must still produce the same structured envelope...
    expect(envelope.is_error).toBe(false);
    expect((envelope.structured_output as { verdict: string }).verdict).toBe('pass');
    // ...and it must have surfaced at least one live tool step.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => /reading|scanning|searching/.test(s))).toBe(true);
  });
});
