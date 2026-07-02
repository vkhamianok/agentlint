import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';

import { type Severity, severities } from './schema.js';

/** A user-defined review rule: plain Markdown with optional frontmatter. */
export interface Rule {
  /** File name without extension; used as the rule's display name. */
  name: string;
  source: 'global' | 'project';
  /** Report violations of this rule at this severity. */
  severity?: Severity;
  /** Glob scoping the rule to matching files. */
  applies?: string;
  body: string;
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

const PRINCIPLES_URL = new URL('../prompts/principles.md', import.meta.url);

/** Built-in principles shipped with the package. */
export async function loadPrinciples(): Promise<string> {
  return readFile(PRINCIPLES_URL, 'utf8');
}

/**
 * Loads user rules. Order encodes precedence: global first, project last —
 * the prompt tells the reviewer that later rules win over earlier ones and
 * that all user rules win over built-in principles.
 */
export async function loadRules(repoRoot: string, homeDir = os.homedir()): Promise<Rule[]> {
  const global = await loadRuleDir(path.join(homeDir, '.agentlint', 'rules'), 'global');
  const project = await loadRuleDir(path.join(repoRoot, '.agentlint', 'rules'), 'project');
  return [...global, ...project];
}

async function loadRuleDir(dir: string, source: Rule['source']): Promise<Rule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isMissingDir(err)) return []; // no rules directory — perfectly fine
    // Anything else (permissions, a file where a dir should be) must not
    // silently mean "no rules": that would fail open.
    throw new RuleError(
      `Cannot read rules directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rules: Rule[] = [];
  for (const file of entries.filter((f) => f.endsWith('.md')).sort()) {
    const raw = await readFile(path.join(dir, file), 'utf8');
    const { data, content } = matter(raw);
    if (!content.trim()) continue;
    rules.push({
      name: path.basename(file, '.md'),
      source,
      severity: parseSeverity(data.severity, path.join(dir, file)),
      applies: parseApplies(data.applies, path.join(dir, file)),
      body: content.trim(),
    });
  }
  return rules;
}

function isMissingDir(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    ((err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

function parseApplies(value: unknown, file: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) return value;
  // A mistyped scope silently applied repo-wide is the same class of silent
  // misconfiguration as a bad severity — fail loudly.
  throw new RuleError(`Invalid applies "${String(value)}" in rule ${file}: must be a glob string.`);
}

function parseSeverity(value: unknown, file: string): Severity | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (severities as readonly string[]).includes(value)) {
    return value as Severity;
  }
  // A misspelled severity silently ignored would mean a rule that never
  // blocks; config mistakes must fail loudly.
  throw new RuleError(
    `Invalid severity "${String(value)}" in rule ${file}. Valid: ${severities.join(', ')}.`,
  );
}
