import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    // Repo-root resolution goes through git, which may differ in drive-letter
    // case or 8.3 short names on Windows — compare canonical forms.
    const [realCwd, realRepo] = [await realpath(call.cwd), await realpath(repo)];
    expect(realCwd.toLowerCase()).toBe(realRepo.toLowerCase());
  });

  it('passes project rules and the task through to the engine call', async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, '.agentlint', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.agentlint', 'rules', 'todos.md'), 'Flag any TODO comments.');
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope(cleanReview));

    await runReview({ cwd: repo, task: 'Rename the greeting.', engine });

    const call = engine.mock.calls[0]![0];
    expect(call.appendSystemPrompt).toContain('Flag any TODO comments.');
    expect(call.appendSystemPrompt).toContain('Correctness'); // built-in principles
    expect(call.prompt).toContain('Rename the greeting.');
  });

  it('reviews the whole repo even when started from a subdirectory', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const sub = path.join(repo, 'sub');
    await mkdir(sub);
    const engine = vi.fn().mockResolvedValue(envelope(cleanReview));

    const outcome = await runReview({ cwd: sub, engine });

    expect(outcome).toMatchObject({ kind: 'reviewed' });
    const call = engine.mock.calls[0]![0];
    const [realCwd, realRepo] = [await realpath(call.cwd), await realpath(repo)];
    expect(realCwd.toLowerCase()).toBe(realRepo.toLowerCase());
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
  const changeSet = {
    description: 'test change',
    diff: 'diff --git a/x b/x\n+added line',
    newFiles: [{ path: 'new.ts', content: 'const a = 1;' }],
    files: ['x', 'new.ts'],
  };
  const base = { changeSet, principles: 'PRINCIPLES TEXT', rules: [] };

  it('embeds diff, new files, principles, and the anti-noise contract', () => {
    const { prompt, appendSystemPrompt } = buildReviewPrompt(base);

    expect(prompt).toContain('+added line');
    expect(prompt).toContain('New file: new.ts');
    expect(appendSystemPrompt).toContain('PRINCIPLES TEXT');
    expect(appendSystemPrompt).toContain('Precision beats recall');
  });

  it('renders user rules after principles, with attributes and precedence note', () => {
    const { appendSystemPrompt } = buildReviewPrompt({
      ...base,
      rules: [
        { name: 'personal', source: 'global' as const, body: 'No console.log.' },
        {
          name: 'db-layer',
          source: 'project' as const,
          severity: 'blocker' as const,
          applies: 'src/db/**',
          body: 'No raw SQL.',
        },
      ],
    });

    expect(appendSystemPrompt).toContain('global rule: personal');
    expect(appendSystemPrompt).toContain(
      'project rule: db-layer (report violations as: blocker; applies only to files matching: src/db/**)',
    );
    expect(appendSystemPrompt).toContain('OVERRIDE the built-in principles');
    expect(appendSystemPrompt.indexOf('PRINCIPLES TEXT')).toBeLessThan(
      appendSystemPrompt.indexOf('No raw SQL.'),
    );
  });

  it('includes the task intent when given, and says so when not', () => {
    const withTask = buildReviewPrompt({ ...base, task: 'Add pagination to the user list.' });
    expect(withTask.prompt).toContain('Add pagination to the user list.');
    expect(withTask.prompt).toContain('Judge the change against this intent');

    const withoutTask = buildReviewPrompt(base);
    expect(withoutTask.prompt).toContain('No task description was provided');
  });
});
