import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

/** A resolved "thing to review": a diff plus enough context to describe it. */
export interface ChangeSet {
  /** Human-readable description used in the prompt and the report. */
  description: string;
  /** Unified diff text; may be empty when only untracked files changed. */
  diff: string;
  /** Untracked files rendered as full content (they have no diff). */
  newFiles: { path: string; content: string }[];
  /** All touched repo-relative paths. */
  files: string[];
}

const MAX_NEW_FILE_BYTES = 64 * 1024;

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new TargetError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Resolves the repository root so that reviews behave the same from any
 * subdirectory: rules are found, and the reviewer's cwd is the repo root.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new TargetError(`Not a git repository: ${cwd}`);
  }
  return path.normalize(result.stdout.trim());
}

/** The default target: everything not yet committed (staged, unstaged, untracked). */
export async function resolveWorkingTreeTarget(cwd: string): Promise<ChangeSet> {
  const inRepo = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    reject: false,
  });
  if (inRepo.exitCode !== 0) {
    throw new TargetError(`Not a git repository: ${cwd}`);
  }
  const hasHead = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd, reject: false });
  if (hasHead.exitCode !== 0) {
    throw new TargetError('The repository has no commits yet; nothing to diff against.');
  }

  const diff = await git(cwd, 'diff', 'HEAD');
  const changedFiles = (await git(cwd, 'diff', 'HEAD', '--name-only')).split('\n').filter(Boolean);
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard'))
    .split('\n')
    .filter(Boolean);

  const newFiles: ChangeSet['newFiles'] = [];
  for (const file of untracked) {
    newFiles.push({ path: file, content: await readNewFile(cwd, file) });
  }

  return {
    description: 'uncommitted working-tree changes (staged, unstaged, and untracked files)',
    diff,
    newFiles,
    files: [...changedFiles, ...untracked],
  };
}

async function readNewFile(cwd: string, file: string): Promise<string> {
  const buf = await readFile(path.join(cwd, file));
  if (buf.length > MAX_NEW_FILE_BYTES) {
    return `<file omitted: ${buf.length} bytes exceeds the ${MAX_NEW_FILE_BYTES}-byte limit>`;
  }
  if (buf.subarray(0, 8000).includes(0)) {
    return '<binary file omitted>';
  }
  return buf.toString('utf8');
}
