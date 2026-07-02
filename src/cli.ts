#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { addRule } from './addrule.js';
import { commitAll, generateCommitMessage } from './commit.js';
import { ConfigError, loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import { runFixes } from './fix.js';
import { gateExitCode } from './gate.js';
import { collectAnswers, confirmFindings } from './interactive.js';
import { type Depth, depths, detectContext } from './profiles.js';
import { type ReportMeta, buildJsonReport } from './report/json.js';
import { renderMarkdownReport } from './report/markdown.js';
import { renderTerminalReport } from './report/terminal.js';
import { type ReviewRunOutcome, runReview } from './review.js';
import { RuleError } from './rules.js';
import { type Severity, severities, severityRank } from './schema.js';
import { TargetError, type TargetSpec, resolveRepoRoot } from './targets.js';

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
  fix?: boolean;
  yes?: boolean;
  commit?: boolean;
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

reviewCommand('diff', 'review uncommitted working-tree changes (default)', true)
  .option('--fix', 'apply confirmed fixes with a separate fixer run, then re-review once')
  .option('--yes', 'with --fix: fix all blocking findings without prompting')
  .option('--commit', 'commit the working tree when the final review passes')
  .action((opts: ReviewCliOptions) => executeDiffFlow(opts));

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

program
  .command('add-rule')
  .description('generate a rule file from a plain-language description')
  .argument('<description...>', 'what the rule should enforce, in any language')
  .option('--global', 'write to ~/.agentlint/rules instead of this project')
  .option('--severity <severity>', `force a severity: ${severities.join(' | ')}`)
  .option('--name <name>', 'kebab-case file name (default: derived from the rule)')
  .action(
    async (
      descriptionWords: string[],
      opts: { global?: boolean; severity?: string; name?: string },
    ) => {
      const severity = parseSeverityOption(opts.severity, '--severity');
      let targetDir: string;
      let model = 'sonnet';
      if (opts.global) {
        targetDir = path.join(os.homedir(), '.agentlint', 'rules');
      } else {
        const repoRoot = await resolveRepoRoot(process.cwd());
        targetDir = path.join(repoRoot, '.agentlint', 'rules');
        model = (await loadConfig(repoRoot)).models.standard;
      }

      const rule = await addRule({
        engine: runClaude,
        description: descriptionWords.join(' '),
        targetDir,
        model,
        severity,
        name: opts.name,
        cwd: process.cwd(),
      });

      console.log(pc.green(`Created ${rule.file}`) + '\n');
      console.log(rule.content);
    },
  );

/**
 * Escape hatch for hooks (like HUSKY=0): a blocked commit sometimes must
 * land anyway, and --no-verify skips every hook, not just this one.
 */
function skipRequested(): boolean {
  if (!process.env.AGENTLINT_SKIP || process.env.AGENTLINT_SKIP === '0') return false;
  console.log(pc.dim('agentlint skipped (AGENTLINT_SKIP is set).'));
  return true;
}

/** The default-command flow: review → optional fix + re-review → optional commit. */
async function executeDiffFlow(opts: ReviewCliOptions): Promise<void> {
  if (skipRequested()) return;
  const target: TargetSpec = { kind: 'working-tree' };
  const task = await resolveTask(opts);
  const interactive = !opts.nonInteractive && Boolean(process.stdout.isTTY) && !process.env.CI;
  // Static flag validation belongs before the first paid engine call.
  if (opts.fix && !interactive && !opts.yes) {
    throw new ConfigError('--fix in a non-interactive run requires --yes.');
  }
  const runOpts = {
    cwd: process.cwd(),
    target,
    task,
    failOn: parseFailOn(opts.failOn),
    depth: parseDepth(opts.depth),
    context: opts.nonInteractive ? detectContext(process.env, false) : detectContext(process.env),
  };

  let outcome = await runReview(runOpts);
  if (outcome.kind === 'empty') {
    console.log(pc.dim('Nothing to review.'));
    process.exitCode = 0;
    return;
  }
  renderOutcome(outcome);
  let exitCode: number = gateExitCode(outcome.result, outcome.failOn);

  if (exitCode !== 0 && opts.fix) {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const answers = interactive ? await collectAnswers(outcome.result.questions) : [];
    const threshold = severityRank(outcome.failOn);
    const candidates = opts.yes
      ? outcome.result.findings.filter((f) => severityRank(f.severity) >= threshold)
      : outcome.result.findings;
    const confirmed = await confirmFindings(candidates, opts.yes ?? false);

    if (confirmed.length > 0) {
      console.log(pc.bold(`\nFixing ${confirmed.length} finding(s)...`));
      const fixResult = await runFixes({
        engine: runClaude,
        repoRoot,
        findings: confirmed,
        model: 'sonnet',
        task,
        answers,
      });
      console.log(`\n${fixResult.summary}\n`);
      console.log(pc.bold('Re-reviewing the fixed working tree...'));

      outcome = await runReview(runOpts);
      if (outcome.kind === 'empty') {
        // The fixer reverted the change entirely — nothing left to gate.
        console.log(pc.dim('Nothing left to review after fixes.'));
        process.exitCode = 0;
        return;
      }
      renderOutcome(outcome);
      exitCode = gateExitCode(outcome.result, outcome.failOn);
    } else {
      console.log(pc.dim('No findings confirmed; nothing to fix.'));
    }
  }

  if (opts.commit) {
    if (exitCode === 0) {
      const repoRoot = await resolveRepoRoot(process.cwd());
      const message = await generateCommitMessage({
        engine: runClaude,
        repoRoot,
        model: 'haiku',
        task,
        reviewSummary: outcome.result.summary,
      });
      const hash = await commitAll(repoRoot, message);
      console.log(pc.green(`Committed ${hash}: ${message.split('\n')[0]}`));
    } else {
      console.log(pc.dim('Not committing: the review did not pass.'));
    }
  }

  await writeReports(outcome, opts);
  process.exitCode = exitCode;
}

function renderOutcome(outcome: Extract<ReviewRunOutcome, { kind: 'reviewed' }>): void {
  console.log(
    renderTerminalReport(outcome.result, {
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      depth: outcome.depth,
      refutedCount: outcome.refutedCount,
    }),
  );
}

async function execute(target: TargetSpec, opts: ReviewCliOptions): Promise<void> {
  if (skipRequested()) return;
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
  return parseSeverityOption(value, '--fail-on');
}

function parseSeverityOption(value: string | undefined, flag: string): Severity | undefined {
  if (value === undefined) return undefined;
  if ((severities as readonly string[]).includes(value)) return value as Severity;
  throw new ConfigError(`Invalid ${flag} "${value}". Valid: ${severities.join(', ')}.`);
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
