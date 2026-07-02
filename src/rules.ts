import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import picomatch from 'picomatch';

import { type Severity, severities } from './schema.js';

/** A review rule: plain Markdown with a severity in the frontmatter. */
export interface Rule {
  /** Rule path without extension, e.g. "structure/single-source-of-truth". */
  name: string;
  source: 'library' | 'global' | 'project';
  /** Report violations of this rule at this severity. */
  severity?: Severity;
  body: string;
}

/**
 * One entry of config.rules: "library:<category>[/<rule>]" enables shipped
 * rules, a path or glob loads the project's own files, and the object form
 * overrides the severity of whatever it selects.
 */
export type RuleSelector = string | { rule: string; severity: Severity };

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

const PRINCIPLES_URL = new URL('../prompts/principles.md', import.meta.url);
const LIBRARY_ROOT = fileURLToPath(new URL('../rules/', import.meta.url));

/** Built-in principles shipped with the package. */
export async function loadPrinciples(): Promise<string> {
  return readFile(PRINCIPLES_URL, 'utf8');
}

/** Raw text of one shipped rule, e.g. as a generation exemplar. */
export async function readLibraryRuleRaw(spec: string): Promise<string> {
  return readFile(path.join(LIBRARY_ROOT, `${spec}.md`), 'utf8');
}

/**
 * The format contract for a complete rule file (frontmatter + body).
 * Generated rules must pass it before they are written to disk.
 */
export function assertRuleMarkdown(content: string, context: string): void {
  const { data, content: body } = matter(content);
  for (const key of Object.keys(data)) {
    if (key !== 'severity') {
      throw new RuleError(`${context}: unknown frontmatter key "${key}". Allowed: severity.`);
    }
  }
  parseSeverity(data.severity, context);
  if (!/^# .+/m.test(body)) {
    throw new RuleError(`${context}: missing the "# Title" heading.`);
  }
  for (const section of ['## Flag', '## Examples', '### Bad', '### Good']) {
    if (!body.includes(section)) {
      throw new RuleError(`${context}: missing the "${section}" section.`);
    }
  }
}

export interface LoadRulesOptions {
  /** From config.rules; undefined = load .agentlint/rules/ directories. */
  selectors?: RuleSelector[];
  /** Global ~/.agentlint rules apply unless explicitly turned off. */
  inheritGlobalRules?: boolean;
  homeDir?: string;
}

/**
 * Loads rules in precedence order — later wins: global taste first, then
 * config selectors (library and paths), then the project's own
 * .agentlint/rules directory. The project directory ALWAYS loads, with or
 * without config.rules: a rule dropped there (e.g. by add-rule) must never
 * be silently ignored because the config switched to selector mode.
 */
export async function loadRules(repoRoot: string, opts: LoadRulesOptions = {}): Promise<Rule[]> {
  const homeDir = opts.homeDir ?? os.homedir();
  const global =
    opts.inheritGlobalRules === false
      ? []
      : await loadRuleDir(path.join(homeDir, '.agentlint', 'rules'), 'global');

  const selected: Rule[] = [];
  for (const selector of opts.selectors ?? []) {
    selected.push(...(await resolveSelector(repoRoot, selector)));
  }

  const project = await loadRuleDir(path.join(repoRoot, '.agentlint', 'rules'), 'project');
  return [...global, ...selected, ...project];
}

async function resolveSelector(repoRoot: string, selector: RuleSelector): Promise<Rule[]> {
  if (typeof selector === 'object') {
    const rules = await resolveSelector(repoRoot, selector.rule);
    return rules.map((rule) => ({ ...rule, severity: selector.severity }));
  }
  if (selector.startsWith('library:')) {
    return loadLibraryRules(selector.slice('library:'.length));
  }
  return loadPathRules(repoRoot, selector);
}

/** "structure" enables a whole shipped category, "structure/<rule>" one rule. */
async function loadLibraryRules(spec: string): Promise<Rule[]> {
  const asDirectory = path.join(LIBRARY_ROOT, spec);
  if (await isDirectory(asDirectory)) {
    const rules = await loadRuleDir(asDirectory, 'library', `${spec}/`);
    if (rules.length > 0) return rules;
  }
  const asFile = `${asDirectory}.md`;
  if (await isFile(asFile)) {
    return [await loadRuleFile(asFile, 'library', spec)];
  }
  throw new RuleError(
    `Unknown library rule "${spec}". Available categories: ${await listLibraryCategories()}.`,
  );
}

/** A repo-relative .md path, or a glob over the repo's .md files. */
async function loadPathRules(repoRoot: string, selector: string): Promise<Rule[]> {
  if (!/[*?[]/.test(selector)) {
    const file = path.join(repoRoot, selector);
    if (!(await isFile(file))) {
      throw new RuleError(`Rule file not found: ${selector} (looked in ${repoRoot}).`);
    }
    return [await loadRuleFile(file, 'project', toRuleName(selector))];
  }

  const isMatch = picomatch(selector.replace(/^\.\//, ''), { dot: false });
  const files = (await walkMarkdownFiles(repoRoot)).filter((relative) => isMatch(relative));
  if (files.length === 0) {
    throw new RuleError(`No rule files match "${selector}" in ${repoRoot}.`);
  }
  return Promise.all(
    files.map((relative) =>
      loadRuleFile(path.join(repoRoot, relative), 'project', toRuleName(relative)),
    ),
  );
}

async function loadRuleDir(dir: string, source: Rule['source'], namePrefix = ''): Promise<Rule[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissingDir(err)) return []; // no rules directory — perfectly fine
    // Anything else (permissions, a file where a dir should be) must not
    // silently mean "no rules": that would fail open.
    throw new RuleError(
      `Cannot read rules directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rules: Rule[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      rules.push(
        ...(await loadRuleDir(path.join(dir, entry.name), source, `${namePrefix}${entry.name}/`)),
      );
    } else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      const file = path.join(dir, entry.name);
      const rule = await loadRuleFile(file, source, namePrefix + path.basename(entry.name, '.md'));
      if (rule.body) rules.push(rule); // empty files are skipped when scanning
    }
  }
  return rules;
}

async function loadRuleFile(file: string, source: Rule['source'], name: string): Promise<Rule> {
  const { data, content } = matter(await readFile(file, 'utf8'));

  // The frontmatter contract is severity and nothing else; a typo'd or
  // outdated key silently ignored would mean a rule that never behaves as
  // written, so unknown keys fail loudly.
  for (const key of Object.keys(data)) {
    if (key !== 'severity') {
      throw new RuleError(`Unknown frontmatter key "${key}" in rule ${file}. Allowed: severity.`);
    }
  }

  return {
    name,
    source,
    severity: parseSeverity(data.severity, file),
    body: content.trim(),
  };
}

function parseSeverity(value: unknown, file: string): Severity | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (severities as readonly string[]).includes(value)) {
    return value as Severity;
  }
  throw new RuleError(
    `Invalid severity "${String(value)}" in rule ${file}. Valid: ${severities.join(', ')}.`,
  );
}

const SKIPPED_WALK_DIRS = new Set(['node_modules', '.git', 'dist']);

async function walkMarkdownFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_WALK_DIRS.has(entry.name)) {
        files.push(...(await walkMarkdownFiles(root, entryRelative)));
      }
    } else if (entry.name.endsWith('.md')) {
      files.push(entryRelative);
    }
  }
  return files;
}

function toRuleName(relativePath: string): string {
  return relativePath.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\.md$/, '');
}

async function listLibraryCategories(): Promise<string> {
  const entries = await readdir(LIBRARY_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .join(', ');
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function isMissingDir(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    ((err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}
