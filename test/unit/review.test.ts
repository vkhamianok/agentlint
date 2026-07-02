import { describe, expect, it, vi } from 'vitest';

import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { buildReviewPrompt } from '../../src/prompt.js';
import { runReview } from '../../src/review.js';
import { makeRepo, write } from '../helpers/repo.js';

function envelope(structuredOutput: unknown): ClaudeEnvelope {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(structuredOutput),
    structured_output: structuredOutput,
    total_cost_usd: 0.12,
    duration_ms: 3400,
  };
}

const cleanReview = {
  verdict: 'pass',
  summary: 'Looks fine.',
  findings: [],
  questions: [],
};

describe('runReview', () => {
  it('short-circuits on a clean working tree without calling the engine', async () => {
    const repo = await makeRepo();
    const engine = vi.fn();

    const outcome = await runReview({ cwd: repo, engine });

    expect(outcome).toEqual({ kind: 'empty' });
    expect(engine).not.toHaveBeenCalled();
  });

  it('sends the diff to the engine and returns the parsed result', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope(cleanReview));

    const outcome = await runReview({ cwd: repo, engine });

    expect(outcome).toMatchObject({ kind: 'reviewed', costUsd: 0.12, durationMs: 3400 });
    const call = engine.mock.calls[0]![0];
    expect(call.prompt).toContain('+export const hello = () => "changed";');
    expect(call.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(call.cwd).toBe(repo);
  });

  it('salvages a prose-only answer with a cheap conversion call', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const prose: ClaudeEnvelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The change looks fine. No findings.',
      total_cost_usd: 0.2,
      duration_ms: 5000,
    };
    const engine = vi
      .fn()
      .mockResolvedValueOnce(prose)
      .mockResolvedValueOnce(envelope(cleanReview));

    const outcome = await runReview({ cwd: repo, engine });

    expect(outcome).toMatchObject({ kind: 'reviewed', costUsd: 0.32 });
    expect(engine).toHaveBeenCalledTimes(2);
    const convertCall = engine.mock.calls[1]![0];
    expect(convertCall.prompt).toContain('The change looks fine.');
    expect(convertCall.tools).toEqual([]);
    expect(convertCall.model).toBe('haiku');
  });

  it('treats schema-violating engine output as an error, never a pass', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope({ verdict: 'pass' }));

    await expect(runReview({ cwd: repo, engine })).rejects.toThrow(
      /did not match the findings schema/,
    );
  });
});

describe('buildReviewPrompt', () => {
  it('embeds diff, new files, and the anti-noise contract', () => {
    const { prompt, appendSystemPrompt } = buildReviewPrompt({
      description: 'test change',
      diff: 'diff --git a/x b/x\n+added line',
      newFiles: [{ path: 'new.ts', content: 'const a = 1;' }],
      files: ['x', 'new.ts'],
    });

    expect(prompt).toContain('+added line');
    expect(prompt).toContain('New file: new.ts');
    expect(appendSystemPrompt).toContain('Precision beats recall');
    expect(appendSystemPrompt).toContain('independent');
  });
});
