import readline from 'node:readline/promises';

import pc from 'picocolors';

import type { Finding } from '../schema.js';

export interface Answer {
  question: string;
  answer: string;
}

/**
 * The manual-mode channel for the reviewer's open questions: answers are
 * passed to the fixer as user decisions. Empty answers are skipped.
 */
export async function collectAnswers(questions: string[]): Promise<Answer[]> {
  if (questions.length === 0) return [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers: Answer[] = [];
    console.log(
      pc.bold('\nThe reviewer left questions. Your answers guide the fixes (empty = skip):'),
    );
    for (const question of questions) {
      const answer = (await rl.question(`${pc.cyan('?')} ${question}\n> `)).trim();
      if (answer) answers.push({ question, answer });
    }
    return answers;
  } finally {
    rl.close();
  }
}

/** Per-finding confirmation; `yes` skips the prompts and confirms everything. */
export async function confirmFindings(findings: Finding[], yes: boolean): Promise<Finding[]> {
  if (yes) return findings;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmed: Finding[] = [];
    for (const finding of findings) {
      const reply = await rl.question(
        `${pc.bold(`Fix "${finding.title}"`)} (${finding.file}) [Y/n] `,
      );
      if (reply.trim() === '' || /^y(es)?$/i.test(reply.trim())) confirmed.push(finding);
    }
    return confirmed;
  } finally {
    rl.close();
  }
}
