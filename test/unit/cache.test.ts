import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cacheDir, cacheKey, readCachedPass, writeCachedPass } from '../../src/cache.js';
import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { runReview } from '../../src/review.js';
import type { ReviewResult } from '../../src/schema.js';
import { makeRepo, write } from '../helpers/repo.js';

const baseParts = { change: 'diff text', guidance: 'principles + rules' };

const passResult: ReviewResult = {
  verdict: 'pass',
  summary: 'Clean.',
  findings: [],
  questions: [],
};

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

describe('cacheKey', () => {
  it('is stable for identical inputs and sensitive to both parts', () => {
    const key = cacheKey(baseParts);
    expect(cacheKey({ ...baseParts })).toBe(key);
    expect(cacheKey({ ...baseParts, change: 'other diff' })).not.toBe(key);
    expect(cacheKey({ ...baseParts, guidance: 'one rule reworded' })).not.toBe(key);
  });
});

describe('cache store', () => {
  const standardSonnet = { depth: 'standard' as const, model: 'sonnet' };

  it('lives inside the git dir and round-trips a pass', async () => {
    const repo = await makeRepo();
    const dir = await cacheDir(repo);
    expect(dir).toContain(path.join('.git', 'agentlint', 'cache'));

    const key = cacheKey(baseParts);
    await writeCachedPass(dir, key, { result: passResult, ...standardSonnet });
    expect((await readCachedPass(dir, key, standardSonnet))?.result).toEqual(passResult);
    expect(await readCachedPass(dir, 'unknown-key', standardSonnet)).toBeUndefined();
  });

  it('a deeper pass satisfies a shallower request, never the reverse', async () => {
    const repo = await makeRepo();
    const dir = await cacheDir(repo);
    const key = cacheKey(baseParts);
    await writeCachedPass(dir, key, { result: passResult, depth: 'standard', model: 'sonnet' });

    expect(await readCachedPass(dir, key, { depth: 'quick', model: 'haiku' })).toBeDefined();
    expect(await readCachedPass(dir, key, { depth: 'deep', model: 'opus' })).toBeUndefined();
  });

  it('at equal depth the model must match, so a model upgrade retires old passes', async () => {
    const repo = await makeRepo();
    const dir = await cacheDir(repo);
    const key = cacheKey(baseParts);
    await writeCachedPass(dir, key, { result: passResult, depth: 'quick', model: 'haiku' });

    expect(await readCachedPass(dir, key, { depth: 'quick', model: 'haiku' })).toBeDefined();
    expect(await readCachedPass(dir, key, { depth: 'quick', model: 'sonnet' })).toBeUndefined();
  });

  it('a shallower pass never overwrites a deeper one', async () => {
    const repo = await makeRepo();
    const dir = await cacheDir(repo);
    const key = cacheKey(baseParts);
    await writeCachedPass(dir, key, { result: passResult, depth: 'deep', model: 'opus' });
    await writeCachedPass(dir, key, { result: passResult, depth: 'quick', model: 'haiku' });

    expect((await readCachedPass(dir, key, { depth: 'deep', model: 'opus' }))?.depth).toBe('deep');
  });

  it('never stores a block verdict', async () => {
    const repo = await makeRepo();
    const dir = await cacheDir(repo);
    const key = cacheKey(baseParts);

    await writeCachedPass(dir, key, {
      result: { ...passResult, verdict: 'block' },
      ...standardSonnet,
    });

    expect(await readCachedPass(dir, key, standardSonnet)).toBeUndefined();
  });
});

describe('runReview caching', () => {
  it('serves a repeated identical review from the cache without an engine call', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope(passResult));

    const first = await runReview({ cwd: repo, engine });
    expect(first).toMatchObject({ kind: 'reviewed', cached: false });
    expect(engine).toHaveBeenCalledTimes(1);

    const second = await runReview({ cwd: repo, engine });
    expect(second).toMatchObject({ kind: 'reviewed', cached: true, costUsd: 0 });
    if (second.kind !== 'reviewed') throw new Error('unreachable');
    expect(second.result).toEqual(passResult);
    expect(engine).toHaveBeenCalledTimes(1); // no new call
  });

  it('a manual standard pass satisfies the quick hook for the same change', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope(passResult));

    await runReview({ cwd: repo, depth: 'standard', engine });
    const hookRun = await runReview({ cwd: repo, context: 'hook', engine });

    expect(hookRun).toMatchObject({ kind: 'reviewed', cached: true, depth: 'standard' });
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('misses when the change is different', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const engine = vi.fn().mockResolvedValue(envelope(passResult));

    await runReview({ cwd: repo, engine });
    await write(repo, 'hello.js', 'export const hello = () => "changed again";\n');
    const second = await runReview({ cwd: repo, engine });

    expect(second).toMatchObject({ kind: 'reviewed', cached: false });
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it('does not cache blocks, and honors noCache', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    const block = {
      verdict: 'block',
      summary: 'Bad.',
      findings: [
        {
          file: 'hello.js',
          line: 1,
          severity: 'blocker',
          title: 't',
          what: 'w',
          why: 'y',
          fixes: ['f'],
          confidence: 'high',
        },
      ],
      questions: [],
    };
    const engine = vi.fn().mockResolvedValue(envelope(block));

    await runReview({ cwd: repo, engine });
    await runReview({ cwd: repo, engine });
    expect(engine).toHaveBeenCalledTimes(2); // blocks are always re-run

    engine.mockResolvedValue(envelope(passResult));
    await runReview({ cwd: repo, engine });
    const bypass = await runReview({ cwd: repo, engine, noCache: true });
    expect(bypass).toMatchObject({ cached: false });
    expect(engine).toHaveBeenCalledTimes(4);
  });

  it('never caches snapshot reviews', async () => {
    const repo = await makeRepo();
    const engine = vi.fn().mockResolvedValue(envelope(passResult));

    await runReview({ cwd: repo, target: { kind: 'snapshot' }, engine });
    const second = await runReview({ cwd: repo, target: { kind: 'snapshot' }, engine });

    expect(second).toMatchObject({ cached: false });
    expect(engine).toHaveBeenCalledTimes(2);
  });
});
