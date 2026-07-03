import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { type ReviewResult, reviewResultSchema } from './schema.js';

/**
 * A content-addressed cache of PASSING verdicts, so a hook does not re-review
 * (and re-bill) a diff an earlier identical run already passed.
 *
 * The key hashes everything that shapes the verdict: the change under review
 * and the guidance that judges it — principles, rules, AND the resolved
 * profile's verdict-shaping settings (model, focus, whether it explores, and
 * whether it refutes). A hit therefore means "this exact change, judged this
 * exact way, already passed." Profiles are an open set with no total order,
 * so there is no cross-profile satisfaction: each profile caches for itself.
 *
 * Only "pass" is cached: a block should stay re-runnable, and a pass is the
 * only verdict a hook can act on without showing findings to a human.
 */

const MAX_ENTRIES = 100;

export interface CacheKeyParts {
  /** The change under review: diff, new files, target kind, task. */
  change: string;
  /** The law and the judge: principles, rules, and the profile's settings. */
  guidance: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.change, parts.guidance]))
    .digest('hex');
}

/**
 * Lives inside the git dir (like git-lfs and rr-cache state): never
 * committed by construction, per clone — and per worktree, which is right,
 * because each worktree has its own working tree to review.
 */
export async function cacheDir(repoRoot: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
  return path.join(path.resolve(repoRoot, result.stdout.trim()), 'agentlint', 'cache');
}

export async function readCachedPass(dir: string, key: string): Promise<ReviewResult | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, `${key}.json`), 'utf8');
  } catch {
    return undefined; // a cache miss, whatever the reason — never fail a review over it
  }
  try {
    const parsed = reviewResultSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.verdict === 'pass') return parsed.data;
  } catch {
    // a corrupt entry is a miss
  }
  return undefined;
}

export async function writeCachedPass(
  dir: string,
  key: string,
  result: ReviewResult,
): Promise<void> {
  if (result.verdict !== 'pass') return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(result), 'utf8');
  await pruneOldEntries(dir);
}

async function pruneOldEntries(dir: string): Promise<void> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  if (entries.length <= MAX_ENTRIES) return;
  const dated = await Promise.all(
    entries.map(async (name) => ({ name, mtime: (await stat(path.join(dir, name))).mtimeMs })),
  );
  const oldest = dated.sort((a, b) => a.mtime - b.mtime).slice(0, dated.length - MAX_ENTRIES);
  await Promise.all(oldest.map((e) => rm(path.join(dir, e.name), { force: true })));
}
