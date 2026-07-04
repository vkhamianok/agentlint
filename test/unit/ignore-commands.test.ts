import { describe, expect, it, vi } from 'vitest';

import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { ignoreFinding, ignoreRun } from '../../src/ignore-commands.js';
import { runReview } from '../../src/review.js';
import { makeRepo, write } from '../helpers/repo.js';

function envelope(structuredOutput: unknown): ClaudeEnvelope {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(structuredOutput),
    structured_output: structuredOutput,
    total_cost_usd: 0.1,
  };
}

const blockOutput = {
  summary: 'A blocker.',
  findings: [
    {
      file: 'hello.js',
      line: 1,
      severity: 'blocker',
      title: 'boom',
      what: 'w',
      why: 'y',
      fixes: ['f'],
      confidence: 'high',
    },
  ],
  questions: [],
};

async function blockingReview() {
  const repo = await makeRepo();
  await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
  const engine = vi.fn().mockResolvedValue(envelope(blockOutput));
  const first = await runReview({ cwd: repo, engine });
  if (first.kind !== 'reviewed') throw new Error('unreachable');
  expect(first.result.verdict).toBe('block');
  return { repo, engine, first };
}

describe('ignoreFinding', () => {
  it('flips the run to pass and sticks on an unchanged re-review, with no new engine call', async () => {
    const { repo, engine, first } = await blockingReview();
    const id = first.result.findings[0]!.id;

    const res = await ignoreFinding(repo, id, 'false positive: verified by hand');
    expect(res).toMatchObject({ scope: 'finding', id, verdict: 'pass' });

    const second = await runReview({ cwd: repo, engine });
    expect(second).toMatchObject({ cached: true });
    if (second.kind !== 'reviewed') throw new Error('unreachable');
    expect(second.result.verdict).toBe('pass');
    expect(second.result.findings[0]!.resolution).toMatchObject({
      state: 'ignored',
      reason: 'false positive: verified by hand',
    });
    expect(engine).toHaveBeenCalledTimes(1); // the ignore did not re-review
  });

  it('requires a reason and errors on an unknown id', async () => {
    const repo = await makeRepo();
    await expect(ignoreFinding(repo, 'abc12345', '')).rejects.toThrow(/reason/);
    await expect(ignoreFinding(repo, 'deadbeef', 'because')).rejects.toThrow(/No cached finding/);
  });
});

describe('ignoreRun', () => {
  it('passes the whole run by its id prefix', async () => {
    const { repo, engine, first } = await blockingReview();

    const res = await ignoreRun(repo, first.runId.slice(0, 12), 'accepted for this commit');
    expect(res).toMatchObject({ scope: 'run', verdict: 'pass' });

    const second = await runReview({ cwd: repo, engine });
    expect(second).toMatchObject({ cached: true });
    if (second.kind !== 'reviewed') throw new Error('unreachable');
    expect(second.result.verdict).toBe('pass');
    expect(second.result.resolution).toMatchObject({ state: 'ignored' });
    expect(engine).toHaveBeenCalledTimes(1);
  });
});
