import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TargetError, normalizeGlobs, resolveTarget } from '../../src/targets.js';
import { git, makeRepo, write } from '../helpers/repo.js';

describe('working-tree target', () => {
  it('captures modified tracked files in the diff', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "goodbye";\n');

    const changeSet = await resolveTarget(repo, { kind: 'working-tree' });

    expect(changeSet.kind).toBe('diff');
    expect(changeSet.diff).toContain('-export const hello = () => "hello";');
    expect(changeSet.diff).toContain('+export const hello = () => "goodbye";');
    expect(changeSet.files).toEqual(['hello.js']);
  });

  it('includes untracked files as full content', async () => {
    const repo = await makeRepo();
    await write(repo, 'brand-new.js', 'export const fresh = 1;\n');

    const changeSet = await resolveTarget(repo, { kind: 'working-tree' });

    expect(changeSet.diff.trim()).toBe('');
    expect(changeSet.newFiles).toEqual([
      { path: 'brand-new.js', content: 'export const fresh = 1;\n' },
    ]);
  });

  it('returns an empty change set on a clean tree', async () => {
    const repo = await makeRepo();
    const changeSet = await resolveTarget(repo, { kind: 'working-tree' });
    expect(changeSet.diff.trim()).toBe('');
    expect(changeSet.newFiles).toEqual([]);
    expect(changeSet.files).toEqual([]);
  });

  it('drops ignored files from diff, untracked list, and files', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "changed";\n');
    await write(repo, 'generated.lock', 'lock v2\n');
    await git(repo, 'add', 'generated.lock');
    await git(repo, 'commit', '-m', 'lockfile');
    await write(repo, 'generated.lock', 'lock v3\n');
    await write(repo, 'notes.tmp', 'scratch\n');

    const changeSet = await resolveTarget(repo, { kind: 'working-tree' }, [
      '**/*.lock',
      '**/*.tmp',
    ]);

    expect(changeSet.diff).toContain('hello.js');
    expect(changeSet.diff).not.toContain('generated.lock');
    expect(changeSet.newFiles).toEqual([]);
    expect(changeSet.files).toEqual(['hello.js']);
  });

  it('rejects a repo without commits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-nohead-'));
    await git(dir, 'init');
    await expect(resolveTarget(dir, { kind: 'working-tree' })).rejects.toThrow(/no commits yet/);
  });
});

describe('staged target', () => {
  it('sees staged changes and ignores unstaged ones', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "staged";\n');
    await git(repo, 'add', '-A');
    await write(repo, 'hello.js', 'export const hello = () => "unstaged on top";\n');

    const changeSet = await resolveTarget(repo, { kind: 'staged' });

    expect(changeSet.diff).toContain('+export const hello = () => "staged";');
    expect(changeSet.diff).not.toContain('unstaged on top');
    expect(changeSet.files).toEqual(['hello.js']);
  });
});

describe('commit target', () => {
  it('resolves a commit diff and its message as task fallback', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "v2";\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'switch greeting to v2');

    const changeSet = await resolveTarget(repo, { kind: 'commit', ref: 'HEAD' });

    expect(changeSet.diff).toContain('+export const hello = () => "v2";');
    expect(changeSet.files).toEqual(['hello.js']);
    expect(changeSet.taskFallback).toBe('switch greeting to v2');
    expect(changeSet.description).toBe('commit HEAD');
  });

  it('handles a root commit', async () => {
    const repo = await makeRepo();
    const changeSet = await resolveTarget(repo, { kind: 'commit', ref: 'HEAD' });
    expect(changeSet.diff).toContain('+export const hello = () => "hello";');
  });

  it('rejects an unknown ref', async () => {
    const repo = await makeRepo();
    await expect(resolveTarget(repo, { kind: 'commit', ref: 'nope' })).rejects.toThrow(
      /Not a commit/,
    );
  });
});

describe('range target', () => {
  it('resolves a two-commit range', async () => {
    const repo = await makeRepo();
    await write(repo, 'a.js', 'export const a = 1;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'add a');
    await write(repo, 'b.js', 'export const b = 2;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'add b');

    const changeSet = await resolveTarget(repo, { kind: 'range', range: 'HEAD~2..HEAD' });

    expect(changeSet.files.sort()).toEqual(['a.js', 'b.js']);
    expect(changeSet.diff).toContain('+export const a = 1;');
    expect(changeSet.diff).toContain('+export const b = 2;');
  });

  it('rejects a malformed range', async () => {
    const repo = await makeRepo();
    await expect(resolveTarget(repo, { kind: 'range', range: 'HEAD' })).rejects.toThrow(
      /Expected the form a\.\.b/,
    );
  });
});

describe('snapshot target', () => {
  it('lists tracked and untracked files with no diff', async () => {
    const repo = await makeRepo();
    await write(repo, 'extra.js', 'export const extra = 1;\n');

    const changeSet = await resolveTarget(repo, { kind: 'snapshot' });

    expect(changeSet.kind).toBe('snapshot');
    expect(changeSet.diff).toBe('');
    expect(changeSet.files).toEqual(['extra.js', 'hello.js']);
  });

  it('applies ignore globs to the listing', async () => {
    const repo = await makeRepo();
    await write(repo, 'skip.tmp', 'x\n');

    const changeSet = await resolveTarget(repo, { kind: 'snapshot' }, ['**/*.tmp']);

    expect(changeSet.files).toEqual(['hello.js']);
  });

  it('keeps only in-scope files when a scope is given', async () => {
    const repo = await makeRepo();
    await write(repo, 'services/orchestrator/run.js', 'export const run = 1;\n');
    await write(repo, 'packages/util.js', 'export const util = 2;\n');

    const changeSet = await resolveTarget(
      repo,
      { kind: 'snapshot' },
      [],
      ['services/orchestrator/**'],
    );

    expect(changeSet.files).toEqual(['services/orchestrator/run.js']);
  });
});

describe('scope filtering on a diff', () => {
  it('restricts the diff and file list to the scope', async () => {
    const repo = await makeRepo();
    await write(repo, 'services/orchestrator/run.js', 'export const run = 1;\n');
    await write(repo, 'packages/util.js', 'export const util = 2;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'seed subsystems');
    await write(repo, 'services/orchestrator/run.js', 'export const run = 2;\n');
    await write(repo, 'packages/util.js', 'export const util = 3;\n');

    const changeSet = await resolveTarget(
      repo,
      { kind: 'working-tree' },
      [],
      ['services/orchestrator/**'],
    );

    expect(changeSet.files).toEqual(['services/orchestrator/run.js']);
    expect(changeSet.diff).toContain('services/orchestrator/run.js');
    expect(changeSet.diff).not.toContain('packages/util.js');
  });
});

describe('normalizeGlobs', () => {
  it('converts backslashes to slashes on Windows, leaves POSIX untouched', () => {
    // Windows: a backslash path a user typed becomes a real glob.
    expect(normalizeGlobs(['services\\orchestrator\\**'], true)).toEqual([
      'services/orchestrator/**',
    ]);
    // POSIX: backslash is an escape / valid filename char — do not touch it.
    expect(normalizeGlobs(['services\\orchestrator\\**'], false)).toEqual([
      'services\\orchestrator\\**',
    ]);
    // Forward-slash globs are unchanged on either platform.
    expect(normalizeGlobs(['a/b/**', 'c/*.ts'], true)).toEqual(['a/b/**', 'c/*.ts']);
  });
});

describe('non-repo directories', () => {
  it('rejects a directory that is not a git repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-norepo-'));
    await expect(resolveTarget(dir, { kind: 'working-tree' })).rejects.toThrow(TargetError);
  });
});
