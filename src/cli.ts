#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { ConfigError } from './config.js';
import { ClaudeEngineError } from './engine/claude.js';
import { gateExitCode } from './gate.js';
import { type Depth, depths, detectContext } from './profiles.js';
import { type ReportMeta, buildJsonReport } from './report/json.js';
import { renderMarkdownReport } from './report/markdown.js';
import { renderTerminalReport } from './report/terminal.js';
import { type ReviewRunOutcome, runReview } from './review.js';
import { RuleError } from './rules.js';
import { type Severity, severities } from './schema.js';
import { TargetError, type TargetSpec } from './targets.js';

const program = new Command();

program
  .name('agentlint')
  .description('A semantic review gate for agent-written code, powered by the Claude CLI')
  .version(pkg.version);

interface ReviewCliOptions {
  task?: string;
  taskFile?: string;
  failOn?: string;
  depth?: string;
  nonInteractive?: boolean;
  report?: string;
  reportMd?: string;
}

function reviewCommand(name: string, description: string, isDefault = false): Command {
  return program
    .command(name, { isDefault })
    .description(description)
    .option('--task <text>', 'what the change was supposed to do')
    .option('--task-file <path>', 'read the task description from a file')
    .option('--fail-on <severity>', `severity that blocks: ${severities.join(' | ')}`)
    .option('--depth <depth>', `review depth: ${depths.join(' | ')} (default: by context)`)
    .option('--non-interactive', 'never prompt; behave like a hook/CI run')
    .option('--report <path>', 'also write a JSON report to this file')
    .option('--report-md <path>', 'also write a Markdown report to this file');
}

reviewCommand('diff', 'review uncommitted working-tree changes (default)', true).action(
  (opts: ReviewCliOptions) => execute({ kind: 'working-tree' }, opts),
);

reviewCommand('staged', 'review staged changes only').action((opts: ReviewCliOptions) =>
  execute({ kind: 'staged' }, opts),
);

reviewCommand('commit', 'review a commit (default: HEAD)')
  .argument('[ref]', 'commit to review', 'HEAD')
  .action((ref: string, opts: ReviewCliOptions) => execute({ kind: 'commit', ref }, opts));

reviewCommand('range', 'review a commit range')
  .argument('<range>', 'range in the form a..b')
  .action((range: string, opts: ReviewCliOptions) => execute({ kind: 'range', range }, opts));

reviewCommand('snapshot', 'review the whole project as it is now').action(
  (opts: ReviewCliOptions) => execute({ kind: 'snapshot' }, opts),
);

async function execute(target: TargetSpec, opts: ReviewCliOptions): Promise<void> {
  const outcome = await runReview({
    cwd: process.cwd(),
    target,
    task: await resolveTask(opts),
    failOn: parseFailOn(opts.failOn),
    depth: parseDepth(opts.depth),
    context: opts.nonInteractive ? detectContext(process.env, false) : detectContext(process.env),
  });

  if (outcome.kind === 'empty') {
    console.log(pc.dim('Nothing to review.'));
    process.exitCode = 0;
    return;
  }

  console.log(
    renderTerminalReport(outcome.result, {
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      depth: outcome.depth,
      refutedCount: outcome.refutedCount,
    }),
  );
  await writeReports(outcome, opts);
  process.exitCode = gateExitCode(outcome.result, outcome.failOn);
}

function parseDepth(value: string | undefined): Depth | undefined {
  if (value === undefined) return undefined;
  if ((depths as readonly string[]).includes(value)) return value as Depth;
  throw new ConfigError(`Invalid --depth "${value}". Valid: ${depths.join(', ')}.`);
}

async function resolveTask(opts: ReviewCliOptions): Promise<string | undefined> {
  if (opts.task && opts.taskFile) {
    throw new TargetError('Use either --task or --task-file, not both.');
  }
  if (opts.taskFile) return readFile(opts.taskFile, 'utf8');
  return opts.task;
}

function parseFailOn(value: string | undefined): Severity | undefined {
  if (value === undefined) return undefined;
  if ((severities as readonly string[]).includes(value)) return value as Severity;
  throw new ConfigError(`Invalid --fail-on "${value}". Valid: ${severities.join(', ')}.`);
}

async function writeReports(
  outcome: Extract<ReviewRunOutcome, { kind: 'reviewed' }>,
  opts: ReviewCliOptions,
): Promise<void> {
  if (!opts.report && !opts.reportMd) return;
  const meta: ReportMeta = {
    target: outcome.target,
    depth: outcome.depth,
    refutedCount: outcome.refutedCount,
    costUsd: outcome.costUsd,
    durationMs: outcome.durationMs,
  };
  if (opts.report) {
    await writeReportFile(
      opts.report,
      JSON.stringify(buildJsonReport(outcome.result, meta), null, 2) + '\n',
    );
  }
  if (opts.reportMd) {
    await writeReportFile(opts.reportMd, renderMarkdownReport(outcome.result, meta));
  }
}

async function writeReportFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, content);
}

program.parseAsync().catch((err: unknown) => {
  if (
    err instanceof ClaudeEngineError ||
    err instanceof TargetError ||
    err instanceof RuleError ||
    err instanceof ConfigError
  ) {
    console.error(pc.red(err.message));
    if (err instanceof ClaudeEngineError && err.detail) console.error(pc.dim(err.detail));
  } else {
    console.error(err);
  }
  process.exit(2);
});
