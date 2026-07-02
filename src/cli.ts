#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { ClaudeEngineError } from './engine/claude.js';
import { gateExitCode } from './gate.js';
import { renderTerminalReport } from './report/terminal.js';
import { runReview } from './review.js';
import { TargetError } from './targets.js';

const program = new Command();

program
  .name('agentlint')
  .description('A semantic review gate for agent-written code, powered by the Claude CLI')
  .version(pkg.version);

async function reviewWorkingTree(): Promise<void> {
  const outcome = await runReview({ cwd: process.cwd() });
  if (outcome.kind === 'empty') {
    console.log(pc.dim('Nothing to review: the working tree is clean.'));
    process.exitCode = 0;
    return;
  }
  console.log(
    renderTerminalReport(outcome.result, {
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
    }),
  );
  process.exitCode = gateExitCode(outcome.result);
}

program
  .command('diff', { isDefault: true })
  .description('review uncommitted working-tree changes (default)')
  .action(reviewWorkingTree);

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ClaudeEngineError || err instanceof TargetError) {
    console.error(pc.red(err.message));
    if (err instanceof ClaudeEngineError && err.detail) console.error(pc.dim(err.detail));
  } else {
    console.error(err);
  }
  process.exit(2);
});
