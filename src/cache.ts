import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import { type Depth, depths } from './profiles.js';
import { reviewResultSchema } from './schema.js';

/**
 * A content-addressed cache of PASSING verdicts, so a hook does not re-review
 * (and re-bill) a diff that an earlier, possibly deeper run already passed.
 *
 * The key hashes what is being judged and by which law: the change itself,
 * the task, and the principles and rules. The judge's strength — depth and
 * model — lives in the entry instead, because a pass at standard depth must
 * satisfy a later quick request for the same change: a deeper look at the
 * same evidence supersedes a shallower one, never the other way around.
 *
 * Only "pass" is cached: a block should stay re-runnable, and a pass is the
 * only verdict a hook can act on without showing findings to a human.
 */

const MAX_ENTRIES = 100;

export interface CacheKeyParts {
  /** The change under review: diff, new files, target kind, task. */
  change: string;
  /** The law it is judged by: principles + rules, verbatim. */
  guidance: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.change, parts.guidance]))
    .digest('hex');
}

const cacheEntrySchema = z.object({
  result: reviewResultSchema,
  depth: z.enum(depths),
  model: z.string(),
});

export type CacheEntry = z.infer<typeof cacheEntrySchema>;

/**
 * Lives inside the git dir (like git-lfs and rr-cache state): never
 * committed by construction, per clone — and per worktree, which is right,
 * because each worktree has its own working tree to review.
 */
export async function cacheDir(repoRoot: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
  return path.join(path.resolve(repoRoot, result.stdout.trim()), 'agentlint', 'cache');
}

/**
 * A hit needs an entry at the requested depth or deeper; at equal depth the
 * model must match too, so upgrading a profile's model retires its old passes.
 */
export async function readCachedPass(
  dir: string,
  key: string,
  requested: { depth: Depth; model: string },
): Promise<CacheEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, `${key}.json`), 'utf8');
  } catch {
    return undefined; // a cache miss, whatever the reason — never fail a review over it
  }
  let entry: CacheEntry;
  try {
    const parsed = cacheEntrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined; // a corrupt entry is a miss
    entry = parsed.data;
  } catch {
    return undefined;
  }

  if (entry.result.verdict !== 'pass') return undefined;
  const entryRank = depths.indexOf(entry.depth);
  const requestedRank = depths.indexOf(requested.depth);
  if (entryRank < requestedRank) return undefined;
  if (entryRank === requestedRank && entry.model !== requested.model) return undefined;
  return entry;
}

export async function writeCachedPass(dir: string, key: string, entry: CacheEntry): Promise<void> {
  if (entry.result.verdict !== 'pass') return;
  // A shallower pass must never overwrite a deeper one for the same change.
  const existing = await readCachedPass(dir, key, { depth: entry.depth, model: entry.model });
  if (existing && depths.indexOf(existing.depth) > depths.indexOf(entry.depth)) return;

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(entry), 'utf8');
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
