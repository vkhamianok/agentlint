import { describe, expect, it, vi } from 'vitest';

import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { runFixes } from '../../src/fix.js';
import type { Finding } from '../../src/schema.js';

function envelope(structuredOutput: unknown, result = ''): ClaudeEnvelope {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: result || JSON.stringify(structuredOutput),
    structured_output: structuredOutput,
    total_cost_usd: 0.05,
  };
}

const finding: Finding = {
  file: 'discount.js',
  line: 7,
  severity: 'blocker',
  title: 'Missing /100',
  what: 'percent used as a fraction',
  why: 'wrong prices',
  fixes: ['restore the division by 100'],
  confidence: 'high',
};

describe('runFixes', () => {
  it('gives the fixer edit tools, acceptEdits, and the confirmed findings', async () => {
    const engine = vi.fn().mockResolvedValue(envelope(undefined, 'Fixed the division.'));

    const result = await runFixes({
      engine,
      repoRoot: '/repo',
      findings: [finding],
      model: 'sonnet',
      task: 'Harden the discount code.',
      answers: [{ question: 'Clamp or throw?', answer: 'Throw.' }],
    });

    expect(result.summary).toBe('Fixed the division.');
    const call = engine.mock.calls[0]![0];
    expect(call.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    expect(call.permissionMode).toBe('acceptEdits');
    expect(call.prompt).toContain('Missing /100');
    expect(call.prompt).toContain('Harden the discount code.');
    expect(call.prompt).toContain('A: Throw.');
    expect(call.appendSystemPrompt).toContain('You do not judge the review');
  });
});
