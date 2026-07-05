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
  scope: string[] = [],
): Promise<ChangeSet> {
  const isIgnored =
    ignore.length > 0 ? picomatch(normalizeGlobs(ignore), { dot: true }) : () => false;
  // A scope is the inverse of ignore: an include-filter that keeps only files
  // under its globs. No scope means "everything" (in-scope is always true).
  const inScope = scope.length > 0 ? picomatch(normalizeGlobs(scope), { dot: true }) : () => true;
  const isExcluded: Matcher = (p) => isIgnored(p) || !inScope(p);
  switch (spec.kind) {
    case 'working-tree':
      return resolveWorkingTree(repoRoot, isExcluded);
    case 'staged':
      return resolveStaged(repoRoot, isExcluded);
    case 'commit':
      return resolveCommit(repoRoot, spec.ref, isExcluded);
    case 'range':
      return resolveRange(repoRoot, spec.range, isExcluded);
    case 'snapshot':
      return resolveSnapshot(repoRoot, isExcluded);
  }
}

type Matcher = (p: string) => boolean;

/**
 * Git reports paths with forward slashes even on Windows, but a Windows user
 * naturally types a glob with backslashes (`services\orchestrator\**`), which
 * picomatch reads as escapes — so it matches nothing. Normalize backslashes to
 * slashes ONLY on Windows, where `\` is a path separator. On POSIX `\` is a
 * valid filename character and a glob escape, so it is left untouched.
 */
export function normalizeGlobs(
  globs: string[],
  isWindows: boolean = process.platform === 'win32',
): string[] {
  return isWindows ? globs.map((g) => g.replace(/\\/g, '/')) : globs;
}

async function resolveWorkingTree(repoRoot: string, isExcluded: Matcher): Promise<ChangeSet> {
  await ensureHead(repoRoot);
  const diff = filterDiff(await git(repoRoot, 'diff', 'HEAD'), isExcluded);
  const changed = await gitLines(repoRoot, 'diff', 'HEAD', '--name-only');
  const untracked = (await gitLines(repoRoot, 'ls-files', '--others', '--exclude-standard')).filter(
    (f) => !isExcluded(f),
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
    files: [...changed.filter((f) => !isExcluded(f)), ...untracked],
  };
}

async function resolveStaged(repoRoot: string, isExcluded: Matcher): Promise<ChangeSet> {
  await ensureHead(repoRoot);
  return {
    kind: 'diff',
    description: 'staged changes (git diff --cached)',
    diff: filterDiff(await git(repoRoot, 'diff', '--cached'), isExcluded),
    newFiles: [],
    files: (await gitLines(repoRoot, 'diff', '--cached', '--name-only')).filter(
      (f) => !isExcluded(f),
    ),
  };
}

async function resolveCommit(
  repoRoot: string,
  ref: string,
  isExcluded: Matcher,
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
    diff: filterDiff(await git(repoRoot, 'show', ref, '--format=', '--patch'), isExcluded),
    newFiles: [],
    files: (await gitLines(repoRoot, 'show', ref, '--format=', '--name-only')).filter(
      (f) => !isExcluded(f),
    ),
    taskFallback: message,
  };
}

async function resolveRange(
  repoRoot: string,
  range: string,
  isExcluded: Matcher,
): Promise<ChangeSet> {
  if (!range.includes('..')) {
    throw new TargetError(`Not a commit range: "${range}". Expected the form a..b.`);
  }
  return {
    kind: 'diff',
    description: `commit range ${range}`,
    diff: filterDiff(await git(repoRoot, 'diff', range), isExcluded),
    newFiles: [],
    files: (await gitLines(repoRoot, 'diff', range, '--name-only')).filter((f) => !isExcluded(f)),
  };
}

async function resolveSnapshot(repoRoot: string, isExcluded: Matcher): Promise<ChangeSet> {
  const tracked = await gitLines(repoRoot, 'ls-files');
  const untracked = await gitLines(repoRoot, 'ls-files', '--others', '--exclude-standard');
  return {
    kind: 'snapshot',
    description:
      'the full project as it is right now (snapshot review: no diff, read files as needed)',
    diff: '',
    newFiles: [],
    files: [...tracked, ...untracked].filter((f) => !isExcluded(f)).sort(),
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
 * Drops excluded files' chunks (ignored or out of scope) from a unified diff.
 * Matches the new-side (b/) path only; a rename out of an excluded path is
 * deliberately shown.
 */
function filterDiff(diff: string, isExcluded: Matcher): string {
  if (!diff.trim()) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return header === null || !isExcluded(header[2]!);
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
