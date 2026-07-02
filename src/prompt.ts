import type { ChangeSet } from './targets.js';

/**
 * M1: a deliberately minimal inline version of the review principles.
 * M2 replaces this with prompts/principles.md + user rules.
 */
const PRINCIPLES = `You review code changes written by AI coding agents. You are independent:
you did not write this change and you owe it no loyalty. Judge it on its merits.

Review for:
- Correctness: does the change do what it claims? Look for logic bugs, off-by-one
  errors, broken edge cases, race conditions.
- Honesty: silently swallowed errors, deleted or weakened tests, disabled checks,
  hardcoded results that fake success.
- Simplicity: needless complexity, dead code, copy-paste where the project already
  has a utility for the job.
- Conventions: does the change match how the surrounding code does things?

Do NOT report: formatting, style preferences, hypothetical issues you have not
verified, or things a compiler or linter would catch.`;

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

export interface ReviewPrompt {
  prompt: string;
  appendSystemPrompt: string;
}

export function buildReviewPrompt(changeSet: ChangeSet): ReviewPrompt {
  const sections: string[] = [
    `Review the following change: ${changeSet.description}.`,
    'You are running inside the repository, so you can read any file for context.',
  ];

  if (changeSet.diff.trim()) {
    sections.push(`## Diff\n\n\`\`\`diff\n${changeSet.diff}\n\`\`\``);
  }
  if (changeSet.newFiles.length > 0) {
    const rendered = changeSet.newFiles
      .map((f) => `### New file: ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    sections.push(`## New untracked files\n\n${rendered}`);
  }

  sections.push(
    'When your review is complete, call the StructuredOutput tool with the result. Do not end with a prose answer.',
  );

  return {
    prompt: sections.join('\n\n'),
    appendSystemPrompt: `${PRINCIPLES}\n\n${OUTPUT_CONTRACT}`,
  };
}
