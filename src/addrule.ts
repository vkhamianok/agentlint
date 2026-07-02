import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';
import { z } from 'zod';

import type { EngineFn } from './review.js';
import { RuleError, assertRuleMarkdown, readLibraryRuleRaw } from './rules.js';
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
