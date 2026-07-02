import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TargetError, resolveWorkingTreeTarget } from '../../src/targets.js';
import { git, makeRepo, write } from '../helpers/repo.js';

describe('resolveWorkingTreeTarget', () => {
  it('captures modified tracked files in the diff', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "goodbye";\n');

    const changeSet = await resolveWorkingTreeTarget(repo);

    expect(changeSet.diff).toContain('-export const hello = () => "hello";');
    expect(changeSet.diff).toContain('+export const hello = () => "goodbye";');
    expect(changeSet.files).toEqual(['hello.js']);
  });

  it('captures staged changes too', async () => {
    const repo = await makeRepo();
    await write(repo, 'hello.js', 'export const hello = () => "staged";\n');
    await git(repo, 'add', '-A');

    const changeSet = await resolveWorkingTreeTarget(repo);

    expect(changeSet.diff).toContain('+export const hello = () => "staged";');
  });

  it('includes untracked files as full content', async () => {
    const repo = await makeRepo();
    await write(repo, 'brand-new.js', 'export const fresh = 1;\n');

    const changeSet = await resolveWorkingTreeTarget(repo);

    expect(changeSet.diff.trim()).toBe('');
    expect(changeSet.newFiles).toEqual([
      { path: 'brand-new.js', content: 'export const fresh = 1;\n' },
    ]);
    expect(changeSet.files).toEqual(['brand-new.js']);
  });

  it('returns an empty change set on a clean tree', async () => {
    const repo = await makeRepo();

    const changeSet = await resolveWorkingTreeTarget(repo);

    expect(changeSet.diff.trim()).toBe('');
    expect(changeSet.newFiles).toEqual([]);
    expect(changeSet.files).toEqual([]);
  });

  it('rejects a directory that is not a git repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-norepo-'));
    await expect(resolveWorkingTreeTarget(dir)).rejects.toThrow(TargetError);
  });

  it('rejects a repo without commits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-nohead-'));
    await git(dir, 'init');
    await expect(resolveWorkingTreeTarget(dir)).rejects.toThrow(/no commits yet/);
  });
});
