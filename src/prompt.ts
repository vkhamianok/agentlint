import type { Rule } from './rules.js';
import type { ChangeSet } from './targets.js';

const OUTPUT_CONTRACT = `Before reporting a finding, verify it against the actual code using your
read tools. Report only findings you would defend in front of the author.
Precision beats recall: a noisy reviewer gets disabled and helps no one.

For every finding provide: what is wrong, why it matters, and one or two
concrete candidate fixes the author can act on immediately.

Severities: "blocker" = wrong or harmful, must not be committed as is;
"warning" = defensible but risky or clearly sub-par; "info" = worth knowing.

Set verdict to "block" if any blocker exists, otherwise "pass".
Put genuine open forks (two defensible options, unclear intent) in "questions";
do not turn them into findings.

Deliver your review ONLY by calling the StructuredOutput tool. Never answer
in plain prose: a review that is not machine-readable cannot gate a commit.`;

export interface PromptContext {
  changeSet: ChangeSet;
  /** Built-in principles (prompts/principles.md). */
  principles: string;
  /** User rules, global first, project last. */
  rules: Rule[];
  /** What the change was supposed to do, when the user provided it. */
  task?: string;
}

export interface ReviewPrompt {
  prompt: string;
  appendSystemPrompt: string;
}

export function buildReviewPrompt(ctx: PromptContext): ReviewPrompt {
  const sections: string[] = [
    `Review the following change: ${ctx.changeSet.description}.`,
    'You are running inside the repository, so you can read any file for context.',
    renderTask(ctx.task),
  ];

  if (ctx.changeSet.kind === 'snapshot') {
    sections.push(
      `## Project files\n\n${ctx.changeSet.files.join('\n')}`,
      'This is a full-project snapshot review: there is no diff. Read the files with your tools, prioritizing entry points and code where defects hurt most. You cannot read everything — say in the summary what you did and did not cover.',
    );
  }
  if (ctx.changeSet.diff.trim()) {
    sections.push(`## Diff\n\n\`\`\`diff\n${ctx.changeSet.diff}\n\`\`\``);
  }
  if (ctx.changeSet.newFiles.length > 0) {
    const rendered = ctx.changeSet.newFiles
      .map((f) => `### New file: ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    sections.push(`## New untracked files\n\n${rendered}`);
  }

  sections.push(
    'When your review is complete, call the StructuredOutput tool with the result. Do not end with a prose answer.',
  );

  const systemParts = [ctx.principles];
  if (ctx.rules.length > 0) systemParts.push(renderRules(ctx.rules));
  systemParts.push(OUTPUT_CONTRACT);

  return {
    prompt: sections.join('\n\n'),
    appendSystemPrompt: systemParts.join('\n\n'),
  };
}

function renderTask(task: string | undefined): string {
  if (task?.trim()) {
    return `## Task intent\n\nThe change was supposed to accomplish this:\n\n${task.trim()}\n\nJudge the change against this intent: flag both what it breaks and what it silently fails to deliver.`;
  }
  return 'No task description was provided, so you cannot judge intent. Review for general quality.';
}

function renderRules(rules: Rule[]): string {
  const rendered = rules.map((rule) => {
    const attrs: string[] = [];
    if (rule.severity) attrs.push(`report violations as: ${rule.severity}`);
    if (rule.applies) attrs.push(`applies only to files matching: ${rule.applies}`);
    const suffix = attrs.length > 0 ? ` (${attrs.join('; ')})` : '';
    return `### ${rule.source} rule: ${rule.name}${suffix}\n\n${rule.body}`;
  });

  return `## User rules

The user defined these rules. They OVERRIDE the built-in principles wherever
they conflict, including instructions to ignore something entirely. When rules
conflict with each other, later rules win (project rules beat global rules).

${rendered.join('\n\n')}`;
}
