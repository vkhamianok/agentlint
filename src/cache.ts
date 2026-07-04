import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import { type ReviewResult, reviewResultSchema } from './schema.js';

/**
 * A content-addressed cache of review results, so a hook does not re-review
 * (and re-bill) a change an earlier identical run already judged.
 *
 * The key hashes everything that shapes the verdict: the change under review,
 * the guidance that judges it (principles, rules, the profile's settings), and
 * failOn. A hit means "this exact change, judged this exact way, was reviewed
 * before" — so its result (and any ignore resolutions written onto it) can be
 * reused. A code change moves the key, so an ignore can never mask a problem in
 * changed code.
 *
 * Both passes and blocks are cached: a block must be re-servable so `ignore`
 * has a stored finding to point at, and re-running an unchanged block returns
 * the same verdict instead of rolling the dice on the model again.
 */

const MAX_ENTRIES = 100;

export interface CacheMeta {
  /** The conditions the review ran under — for humans reading the cache. */
  profile: string;
  model: string;
  target: string;
  failOn: string;
  at: string;
}

const cacheEntrySchema = z.looseObject({
  result: reviewResultSchema,
  meta: z.looseObject({
    profile: z.string(),
    model: z.string(),
    target: z.string(),
    failOn: z.string(),
    at: z.string(),
  }),
});

export interface CacheEntry {
  result: ReviewResult;
  meta: CacheMeta;
}

export interface CacheKeyParts {
  /** The change under review: diff, new files, target kind, task. */
  change: string;
  /** The law and the judge: principles, rules, the profile's settings, failOn. */
  guidance: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.change, parts.guidance]))
    .digest('hex');
}

/**
 * Lives inside the git dir (like git-lfs and rr-cache state): never committed
 * by construction, per clone — and per worktree, which is right, because each
 * worktree has its own working tree to review.
 */
export async function cacheDir(repoRoot: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
  return path.join(path.resolve(repoRoot, result.stdout.trim()), 'agentlint', 'cache');
}

export async function readCache(dir: string, key: string): Promise<CacheEntry | undefined> {
  return parseEntry(await tryRead(path.join(dir, `${key}.json`)));
}

export async function writeCache(dir: string, key: string, entry: CacheEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(entry), 'utf8');
  await pruneOldEntries(dir);
}

/** Every readable entry with its key (filename stem) — for `ignore` to scan. */
export async function readAllEntries(
  dir: string,
): Promise<Array<{ key: string; entry: CacheEntry }>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Array<{ key: string; entry: CacheEntry }> = [];
  for (const name of names) {
    const entry = parseEntry(await tryRead(path.join(dir, name)));
    if (entry) out.push({ key: name.replace(/\.json$/, ''), entry });
  }
  return out;
}

async function tryRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined; // a cache miss, whatever the reason — never fail over it
  }
}

function parseEntry(raw: string | undefined): CacheEntry | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = cacheEntrySchema.safeParse(JSON.parse(raw));
    // A pre-format or corrupt entry is a miss, not a crash.
    return parsed.success ? (parsed.data as CacheEntry) : undefined;
  } catch {
    return undefined;
  }
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
