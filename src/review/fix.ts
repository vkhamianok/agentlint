import type { Answer } from '../commands/interactive.js';
import type { Finding } from '../schema.js';
import type { EngineFn } from './run.js';

const FIXER_SYSTEM = `You are a fixer. An independent code review found the problems below in
this repository's uncommitted changes. Your only job is to fix the confirmed
findings — nothing else.

- Prefer the first candidate fix of each finding unless the code clearly
  calls for the alternative.
- Do not refactor, clean up, or touch code unrelated to the findings.
- Do not commit, stage, or run destructive commands.
- You do not judge the review: even if you disagree with a finding, apply
  the most reasonable fix for it.`;

export interface FixRunResult {
  /** The fixer's own description of what it changed. */
  summary: string;
  costUsd: number;
}

/**
 * One fixer invocation for all confirmed findings. Fixer and reviewer stay
 * separate processes: the reviewer never edits, the fixer never judges.
 */
export async function runFixes(opts: {
  engine: EngineFn;
  repoRoot: string;
  findings: Finding[];
  model: string;
  task?: string;
  answers?: Answer[];
}): Promise<FixRunResult> {
  const sections = [
    'Fix the following confirmed review findings in this repository.',
    opts.task ? `## The change was supposed to accomplish\n\n${opts.task}` : '',
    `## Confirmed findings\n\n\`\`\`json\n${JSON.stringify(opts.findings, null, 2)}\n\`\`\``,
  ];
  if (opts.answers && opts.answers.length > 0) {
    const qa = opts.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join('\n');
    sections.push(`## User decisions on the reviewer's questions\n\n${qa}`);
  }
  sections.push('When done, reply with a short summary of what you changed.');

  const envelope = await opts.engine({
    prompt: sections.filter(Boolean).join('\n\n'),
    appendSystemPrompt: FIXER_SYSTEM,
    cwd: opts.repoRoot,
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    permissionMode: 'acceptEdits',
    model: opts.model,
    maxTurns: 60,
    maxBudgetUsd: 2,
    timeoutMs: 15 * 60 * 1000,
  });

  return { summary: envelope.result.trim(), costUsd: envelope.total_cost_usd ?? 0 };
}
