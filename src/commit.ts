import { execa } from 'execa';
import { z } from 'zod';

import type { EngineFn } from './review.js';
import { toCliJsonSchema } from './schema.js';
import { TargetError } from './targets.js';

const commitMessageSchema = z.looseObject({
  subject: z.string().describe('imperative, under 72 characters, no trailing period'),
  body: z
    .string()
    .describe('one short paragraph explaining what and why; empty string if the subject is enough'),
});

const commitMessageJsonSchema = toCliJsonSchema(commitMessageSchema);

/** Generates a commit message from the task intent and the review summary. */
export async function generateCommitMessage(opts: {
  engine: EngineFn;
  repoRoot: string;
  model: string;
  task?: string;
  reviewSummary: string;
}): Promise<string> {
  const stat = await git(opts.repoRoot, 'diff', 'HEAD', '--stat');
  const envelope = await opts.engine({
    prompt: [
      'Write a git commit message for the change described below. Call the StructuredOutput tool with it.',
      opts.task ? `## What the change was supposed to do\n\n${opts.task}` : '',
      `## Reviewer summary of the change\n\n${opts.reviewSummary}`,
      `## Changed files\n\n${stat}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    cwd: opts.repoRoot,
    jsonSchema: commitMessageJsonSchema,
    tools: [],
    model: opts.model,
    maxTurns: 4,
    maxBudgetUsd: 0.2,
    timeoutMs: 2 * 60 * 1000,
  });

  const parsed = commitMessageSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new TargetError('Could not generate a commit message; commit manually.');
  }
  const { subject, body } = parsed.data;
  return body.trim() ? `${subject}\n\n${body.trim()}` : subject;
}

/** Stages everything and commits. Only called after a passing review. */
export async function commitAll(repoRoot: string, message: string): Promise<string> {
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, 'commit', '-m', message);
  return (await git(repoRoot, 'rev-parse', '--short', 'HEAD')).trim();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new TargetError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
