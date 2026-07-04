import os from 'node:os';

import { cacheDir, readAllEntries, writeCache } from './cache.js';
import { ConfigError } from './config.js';
import { type Resolution, type Severity, deriveVerdict } from './schema.js';

export interface IgnoreResult {
  scope: 'finding' | 'run';
  /** The finding id, or the run's short key. */
  id: string;
  /** The finding title, or the run's target description. */
  title: string;
  /** The run's verdict after the ignore is applied. */
  verdict: 'pass' | 'block';
}

/**
 * Marks one finding as ignored across the verdict cache, with a reason. The
 * run's verdict is re-derived from the remaining open findings, so a re-review
 * of the unchanged change (a cache hit) proceeds if nothing else blocks.
 */
export async function ignoreFinding(
  repoRoot: string,
  id: string,
  reason: string,
): Promise<IgnoreResult> {
  requireReason(reason, 'agentlint ignore <id> "why"');
  const dir = await cacheDir(repoRoot);
  const match = (await readAllEntries(dir)).find(({ entry }) =>
    entry.result.findings.some((f) => f.id === id),
  );
  if (!match) {
    throw new ConfigError(
      `No cached finding "${id}". Run a review first, then ignore an id shown in its report.`,
    );
  }
  const finding = match.entry.result.findings.find((f) => f.id === id)!;
  finding.resolution = ignored(reason);
  match.entry.result.verdict = reverdict(match.entry);
  await writeCache(dir, match.key, match.entry);
  return { scope: 'finding', id, title: finding.title, verdict: match.entry.result.verdict };
}

/** Marks a whole run ignored with a reason — the reasoned form of AGENTLINT_SKIP. */
export async function ignoreRun(
  repoRoot: string,
  runId: string,
  reason: string,
): Promise<IgnoreResult> {
  requireReason(reason, 'agentlint ignore --run <id> "why"');
  const dir = await cacheDir(repoRoot);
  const matches = (await readAllEntries(dir)).filter(({ key }) => key.startsWith(runId));
  if (matches.length === 0) {
    throw new ConfigError(`No cached run starting "${runId}". Run a review first.`);
  }
  if (matches.length > 1) {
    throw new ConfigError(
      `Run "${runId}" is ambiguous (${matches.length} match) — use more characters.`,
    );
  }
  const match = matches[0]!;
  match.entry.result.resolution = ignored(reason);
  match.entry.result.verdict = reverdict(match.entry);
  await writeCache(dir, match.key, match.entry);
  return {
    scope: 'run',
    id: match.key.slice(0, 12),
    title: match.entry.meta.target,
    verdict: match.entry.result.verdict,
  };
}

function reverdict(entry: {
  result: { findings: { severity: Severity; resolution?: Resolution }[]; resolution?: Resolution };
  meta: { failOn: string };
}): 'pass' | 'block' {
  return deriveVerdict(
    entry.result.findings,
    entry.meta.failOn as Severity,
    entry.result.resolution,
  );
}

function ignored(reason: string): Resolution {
  return {
    state: 'ignored',
    reason: reason.trim(),
    by: currentUser(),
    at: new Date().toISOString(),
  };
}

function requireReason(reason: string, usage: string): void {
  if (!reason.trim()) throw new ConfigError(`An ignore needs a reason: ${usage}.`);
}

function currentUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined; // no user info (some CI) — the reason still records intent
  }
}
