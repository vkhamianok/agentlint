import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import picomatch from 'picomatch';

/** What to review, as selected on the command line. */
export type TargetSpec =
  | { kind: 'working-tree' }
  | { kind: 'staged' }
  | { kind: 'commit'; ref: string }
  | { kind: 'range'; range: string }
  | { kind: 'snapshot' };

/** A resolved "thing to review": a diff (or file list) plus context. */
export interface ChangeSet {
  kind: 'diff' | 'snapshot';
  /** Human-readable description used in the prompt and the report. */
  description: string;
  /** Unified diff text; empty for snapshots and untracked-only changes. */
  diff: string;
  /** Untracked files rendered as full content (they have no diff). */
  newFiles: { path: string; content: string }[];
  /** All repo-relative paths under review. */
  files: string[];
  /** Commit message — the task-intent fallback for commit targets. */
  taskFallback?: string;
}

const MAX_NEW_FILE_BYTES = 64 * 1024;

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

export async function resolveTarget(
  repoRoot: string,
  spec: TargetSpec,
  ignore: string[] = [],
): Promise<ChangeSet> {
  const isIgnored = ignore.length > 0 ? picomatch(ignore, { dot: true }) : () => false;
  switch (spec.kind) {
    case 'working-tree':
      return resolveWorkingTree(repoRoot, isIgnored);
    case 'staged':
      return resolveStaged(repoRoot, isIgnored);
    case 'commit':
      return resolveCommit(repoRoot, spec.ref, isIgnored);
    case 'range':
      return resolveRange(repoRoot, spec.range, isIgnored);
    case 'snapshot':
      return resolveSnapshot(repoRoot, isIgnored);
  }
}

type Matcher = (p: string) => boolean;

async function resolveWorkingTree(repoRoot: string, isIgnored: Matcher): Promise<ChangeSet> {
  await ensureHead(repoRoot);
  const diff = filterDiff(await git(repoRoot, 'diff', 'HEAD'), isIgnored);
  const changed = await gitLines(repoRoot, 'diff', 'HEAD', '--name-only');
  const untracked = (await gitLines(repoRoot, 'ls-files', '--others', '--exclude-standard')).filter(
    (f) => !isIgnored(f),
  );

  const newFiles: ChangeSet['newFiles'] = [];
  for (const file of untracked) {
    newFiles.push({ path: file, content: await readNewFile(repoRoot, file) });
  }

  return {
    kind: 'diff',
    description: 'uncommitted working-tree changes (staged, unstaged, and untracked files)',
    diff,
    newFiles,
    files: [...changed.filter((f) => !isIgnored(f)), ...untracked],
  };
}

async function resolveStaged(repoRoot: string, isIgnored: Matcher): Promise<ChangeSet> {
  await ensureHead(repoRoot);
  return {
    kind: 'diff',
    description: 'staged changes (git diff --cached)',
    diff: filterDiff(await git(repoRoot, 'diff', '--cached'), isIgnored),
    newFiles: [],
    files: (await gitLines(repoRoot, 'diff', '--cached', '--name-only')).filter(
      (f) => !isIgnored(f),
    ),
  };
}

async function resolveCommit(
  repoRoot: string,
  ref: string,
  isIgnored: Matcher,
): Promise<ChangeSet> {
  const verified = await execa('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
    reject: false,
  });
  if (verified.exitCode !== 0) {
    throw new TargetError(`Not a commit: "${ref}".`);
  }
  const message = (await git(repoRoot, 'log', '-1', '--format=%B', ref)).trim();
  return {
    kind: 'diff',
    description: `commit ${ref}`,
    diff: filterDiff(await git(repoRoot, 'show', ref, '--format=', '--patch'), isIgnored),
    newFiles: [],
    files: (await gitLines(repoRoot, 'show', ref, '--format=', '--name-only')).filter(
      (f) => !isIgnored(f),
    ),
    taskFallback: message,
  };
}

async function resolveRange(
  repoRoot: string,
  range: string,
  isIgnored: Matcher,
): Promise<ChangeSet> {
  if (!range.includes('..')) {
    throw new TargetError(`Not a commit range: "${range}". Expected the form a..b.`);
  }
  return {
    kind: 'diff',
    description: `commit range ${range}`,
    diff: filterDiff(await git(repoRoot, 'diff', range), isIgnored),
    newFiles: [],
    files: (await gitLines(repoRoot, 'diff', range, '--name-only')).filter((f) => !isIgnored(f)),
  };
}

async function resolveSnapshot(repoRoot: string, isIgnored: Matcher): Promise<ChangeSet> {
  const tracked = await gitLines(repoRoot, 'ls-files');
  const untracked = await gitLines(repoRoot, 'ls-files', '--others', '--exclude-standard');
  return {
    kind: 'snapshot',
    description:
      'the full project as it is right now (snapshot review: no diff, read files as needed)',
    diff: '',
    newFiles: [],
    files: [...tracked, ...untracked].filter((f) => !isIgnored(f)).sort(),
  };
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

async function ensureHead(repoRoot: string): Promise<void> {
  const hasHead = await execa('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
    reject: false,
  });
  if (hasHead.exitCode !== 0) {
    throw new TargetError('The repository has no commits yet; nothing to diff against.');
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new TargetError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function gitLines(cwd: string, ...args: string[]): Promise<string[]> {
  return (await git(cwd, ...args)).split('\n').filter(Boolean);
}

/**
 * Drops ignored files' chunks from a unified diff. Matches the new-side
 * (b/) path only; a rename out of an ignored path is deliberately shown.
 */
function filterDiff(diff: string, isIgnored: Matcher): string {
  if (!diff.trim()) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return header === null || !isIgnored(header[2]!);
    })
    .join('');
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
