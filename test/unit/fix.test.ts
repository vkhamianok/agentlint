import { describe, expect, it, vi } from 'vitest';

import { commitAll, generateCommitMessage } from '../../src/commit.js';
import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { runFixes } from '../../src/fix.js';
import type { Finding } from '../../src/schema.js';
import { makeRepo, write } from '../helpers/repo.js';

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

describe('generateCommitMessage', () => {
  it('builds subject + body from structured output', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "v2";\n');
    const engine = vi
      .fn()
      .mockResolvedValue(envelope({ subject: 'Switch greeting to v2', body: 'For the beta.' }));

    const message = await generateCommitMessage({
      engine,
      repoRoot: repo,
      model: 'haiku',
      task: 'Switch greeting',
      reviewSummary: 'Clean change.',
    });

    expect(message).toBe('Switch greeting to v2\n\nFor the beta.');
    const call = engine.mock.calls[0]![0];
    expect(call.tools).toEqual([]);
    expect(call.prompt).toContain('Clean change.');
    expect(call.prompt).toContain('hello.js'); // diff --stat
  });

  it('fails loudly when no message could be generated', async () => {
    const repo = await makeRepo();
    const engine = vi.fn().mockResolvedValue(envelope(undefined, 'prose'));

    await expect(
      generateCommitMessage({
        engine,
        repoRoot: repo,
        model: 'haiku',
        reviewSummary: 's',
      }),
    ).rejects.toThrow(/commit manually/);
  });
});

describe('commitAll', () => {
  it('stages everything and commits with the given message', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "committed";\n');
    await write(repo, 'new-file.js', 'export const brandNew = true;\n');

    const hash = await commitAll(repo, 'Fix greeting\n\nBody line.');

    expect(hash).toMatch(/^[0-9a-f]{4,}$/);
    const { execa } = await import('execa');
    const log = await execa('git', ['log', '-1', '--format=%s'], { cwd: repo });
    expect(log.stdout).toBe('Fix greeting');
    const status = await execa('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout).toBe('');
  });
});
