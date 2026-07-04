import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';
import { z } from 'zod';

import { loadConfig } from './config.js';
import type { EngineFn } from './review.js';
import {
  type Rule,
  RuleError,
  assertRuleMarkdown,
  loadRules,
  readLibraryRuleRaw,
} from './rules.js';
import { type Severity, severities, toCliJsonSchema } from './schema.js';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const generatedRuleSchema = z.looseObject({
  name: z
    .string()
    .regex(KEBAB_CASE)
    .describe('short kebab-case file name derived from the rule, e.g. "verb-function-names"'),
  severity: z
    .enum(severities)
    .describe('blocker only for things that must never be committed; else warning or info'),
  body: z
    .string()
    .describe('the full rule markdown WITHOUT frontmatter, starting with the "# Title" line'),
});

const generatedRuleJsonSchema = toCliJsonSchema(generatedRuleSchema);

export interface GeneratedRule {
  name: string;
  severity: Severity;
  content: string;
  file: string;
}

/** Turns a plain-language description into a written, format-checked rule file. */
export async function addRule(opts: {
  engine: EngineFn;
  description: string;
  /** Resolved rules directory: project .agentlint/rules or the global one. */
  targetDir: string;
  model: string;
  severity?: Severity;
  name?: string;
  cwd: string;
}): Promise<GeneratedRule> {
  if (opts.name && !KEBAB_CASE.test(opts.name)) {
    throw new RuleError(`--name must be kebab-case, got "${opts.name}".`);
  }

  const envelope = await opts.engine({
    prompt: await buildGeneratorPrompt(opts.description, opts.severity),
    jsonSchema: generatedRuleJsonSchema,
    tools: [],
    model: opts.model,
    maxTurns: 4,
    maxBudgetUsd: 0.3,
    timeoutMs: 3 * 60 * 1000,
    cwd: opts.cwd,
  });

  const parsed = generatedRuleSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new RuleError(`The generator did not return a valid rule: ${parsed.error.message}`);
  }

  const severity = opts.severity ?? parsed.data.severity;
  const name = opts.name ?? parsed.data.name;
  const content = `---\nseverity: ${severity}\n---\n\n${parsed.data.body.trim()}\n`;
  // The same contract the library lives by; a malformed generation must be
  // a loud error, not a broken file in the rules directory.
  assertRuleMarkdown(content, `generated rule "${name}"`);

  const file = path.join(opts.targetDir, `${name}.md`);
  await mkdir(opts.targetDir, { recursive: true });
  try {
    // wx: create only — an existing file fails atomically, no check-then-write race.
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RuleError(`Rule file already exists: ${file}. Pick a different --name.`);
    }
    throw err;
  }

  return { name, severity, content, file };
}

/** Rewrites an existing rule per a plain-language instruction. */
export async function editRule(opts: {
  engine: EngineFn;
  slug: string;
  instruction: string;
  targetDir: string;
  model: string;
  severity?: Severity;
  cwd: string;
}): Promise<GeneratedRule> {
  const file = await resolveExistingRule(opts.targetDir, opts.slug);
  const current = await readFile(file, 'utf8');

  const envelope = await opts.engine({
    prompt: buildEditorPrompt(current, opts.instruction, opts.severity),
    jsonSchema: editedRuleJsonSchema,
    tools: [],
    model: opts.model,
    maxTurns: 4,
    maxBudgetUsd: 0.3,
    timeoutMs: 3 * 60 * 1000,
    cwd: opts.cwd,
  });

  const parsed = editedRuleSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new RuleError(`The editor did not return a valid rule: ${parsed.error.message}`);
  }

  const severity = opts.severity ?? parsed.data.severity;
  const content = `---\nseverity: ${severity}\n---\n\n${parsed.data.body.trim()}\n`;
  assertRuleMarkdown(content, `edited rule "${opts.slug}"`);
  await writeFile(file, content, 'utf8'); // overwriting is the point here

  return { name: opts.slug, severity, content, file };
}

/** Removes a rule file; the explicit command is the confirmation. */
export async function removeRule(targetDir: string, slug: string): Promise<string> {
  const file = await resolveExistingRule(targetDir, slug);
  await rm(file);
  return file;
}

const ruleCheckSchema = z.looseObject({
  summary: z.string().describe('one paragraph on the overall health of the rule set'),
  findings: z.array(
    z.looseObject({
      rules: z.array(z.string()).min(1).describe('the rule names involved'),
      kind: z.enum(['contradiction', 'duplication', 'vagueness', 'noise-risk', 'improvement']),
      problem: z.string().describe('what is wrong with these rules, concretely'),
      recommendation: z.string().describe('a concrete rewording or restructuring to apply'),
    }),
  ),
});

const ruleCheckJsonSchema = toCliJsonSchema(ruleCheckSchema);

export type RuleCheckResult = z.infer<typeof ruleCheckSchema>;

/**
 * A meta-review of the effective rule set: rules are prompts, and prompts
 * can contradict, duplicate, or blur each other without anyone noticing.
 */
export async function checkRules(opts: {
  engine: EngineFn;
  repoRoot: string;
  model: string;
  homeDir?: string;
}): Promise<RuleCheckResult> {
  const listing = await listRules(opts.repoRoot, opts.homeDir);
  if (listing.length === 0) {
    throw new RuleError('No rules are enabled — nothing to check. Try: agentlint init.');
  }
  const config = await loadConfig(opts.repoRoot, opts.homeDir);
  const rules = await loadRules(opts.repoRoot, {
    selectors: config.rules,
    inheritGlobalRules: config.inheritGlobalRules,
    homeDir: opts.homeDir,
  });

  const rendered = rules
    .map(
      (r) =>
        `### ${r.source} rule: ${r.name}${r.severity ? ` (severity: ${r.severity})` : ''}\n\n${r.body}`,
    )
    .join('\n\n---\n\n');

  const envelope = await opts.engine({
    prompt: [
      'You are auditing the rule set of an LLM code reviewer. Each rule below is a prompt the reviewer follows. Precedence semantics: later rules win over earlier ones, and all of them override the built-in principles — so a later rule deliberately narrowing an earlier one is legitimate; flag only conflicts that look unintentional.',
      'Report, with concrete rewordings:',
      '- contradictions: two rules demand incompatible behavior and nothing signals intent;',
      '- duplication: the same law stated twice (the copies will drift apart);',
      '- vagueness: a rule a reviewer cannot falsify — no concrete triggers, taste words ("clean", "good") without criteria;',
      '- noise risk: categorical wording that will flag legitimate code, or a missing "Do not flag" section where borderline cases are obvious;',
      '- improvement: sharper wording, missing Bad/Good examples where they would change behavior.',
      'Only report what the rule owner should act on. An empty findings list is a valid answer for a healthy set.',
      `## The rule set (${rules.length} rules, in precedence order)\n\n${rendered}`,
      'Call the StructuredOutput tool with your audit. Do not end with a prose answer.',
    ].join('\n\n'),
    jsonSchema: ruleCheckJsonSchema,
    tools: [],
    model: opts.model,
    maxTurns: 4,
    maxBudgetUsd: 1,
    timeoutMs: 5 * 60 * 1000,
    cwd: opts.repoRoot,
  });

  const parsed = ruleCheckSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new RuleError(`The rule audit did not return a valid result: ${parsed.error.message}`);
  }
  return parsed.data;
}

export interface RuleListing {
  source: Rule['source'];
  name: string;
  severity?: Severity;
  /** The rule's H1 title, its one-line self-description. */
  title: string;
}

/**
 * The effective rule set of a repository: everything a review would load,
 * in load order — which is also precedence order, later wins.
 */
export async function listRules(repoRoot: string, homeDir?: string): Promise<RuleListing[]> {
  const config = await loadConfig(repoRoot, homeDir);
  const rules = await loadRules(repoRoot, {
    selectors: config.rules,
    inheritGlobalRules: config.inheritGlobalRules,
    homeDir,
  });
  return rules.map((rule) => ({
    source: rule.source,
    name: rule.name,
    severity: rule.severity,
    title: rule.body.match(/^# (.+)$/m)?.[1] ?? '(untitled)',
  }));
}

const editedRuleSchema = z.looseObject({
  severity: z
    .enum(severities)
    .describe('keep the current severity unless the instruction changes it'),
  body: z
    .string()
    .describe('the revised rule markdown WITHOUT frontmatter, starting with the "# Title" line'),
});

const editedRuleJsonSchema = toCliJsonSchema(editedRuleSchema);

function buildEditorPrompt(
  current: string,
  instruction: string,
  severity: Severity | undefined,
): string {
  return [
    'Revise the agentlint review rule below according to the instruction. Change ONLY what the instruction asks for; preserve the rest of the wording, the structure (# Title, lead paragraph, ## Flag, ## Do not flag, ## Examples with ### Bad and ### Good), and the tone.',
    `## Instruction from the user (may be in any language; the rule stays in English)\n\n${instruction}`,
    severity ? `Set severity to: ${severity}.` : '',
    `## Current rule\n\n\`\`\`\`markdown\n${current}\n\`\`\`\``,
    'Call the StructuredOutput tool with: severity and body (the revised markdown WITHOUT frontmatter, starting with "# ").',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Maps a slug to an existing file inside targetDir, refusing path escapes. */
async function resolveExistingRule(targetDir: string, slug: string): Promise<string> {
  const root = path.resolve(targetDir);
  const file = path.resolve(root, `${slug}.md`);
  if (!file.startsWith(root + path.sep)) {
    throw new RuleError(`Invalid rule slug "${slug}".`);
  }
  try {
    await stat(file);
    return file;
  } catch {
    const available = await listRuleSlugs(root);
    throw new RuleError(
      `Rule "${slug}" not found in ${root}.` +
        (available.length > 0
          ? ` Available: ${available.join(', ')}.`
          : ' The directory has no rules.'),
    );
  }
}

async function listRuleSlugs(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      slugs.push(...(await listRuleSlugs(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      slugs.push(prefix + path.basename(entry.name, '.md'));
    }
  }
  return slugs;
}

async function buildGeneratorPrompt(
  description: string,
  severity: Severity | undefined,
): Promise<string> {
  // The exemplar teaches the house style better than any specification;
  // its frontmatter is stripped because the generator returns body only.
  const exemplar = matter(await readLibraryRuleRaw('naming/self-descriptive-names')).content.trim();
  return [
    'Write ONE agentlint review rule from the description below. An agentlint rule is a prompt that an LLM code reviewer follows when judging a change, so every sentence must be actionable review guidance.',
    `## Rule description from the user (may be in any language; write the rule in English)\n\n${description}`,
    severity
      ? `Use severity: ${severity}.`
      : 'Choose the severity yourself: "blocker" only for violations that must never be committed, "warning" for risky or clearly sub-par code, "info" for worth-knowing.',
    'Follow EXACTLY the structure of the exemplar: an "# Title", one lead paragraph stating the rule and why it matters, "## Flag" bullets with concrete triggers, "## Do not flag" bullets for borderline cases that must not become noise, and "## Examples" with short "### Bad" and "### Good" fenced code snippets of 3-8 lines each.',
    `## Exemplar (structure and tone to imitate)\n\n\`\`\`\`markdown\n${exemplar}\n\`\`\`\``,
    'Call the StructuredOutput tool with: name (kebab-case, derived from the rule essence), severity, and body (the rule markdown WITHOUT frontmatter, starting with "# ").',
  ].join('\n\n');
}
