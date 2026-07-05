import { readFile } from 'node:fs/promises';

import { Command } from 'commander';
import pc from 'picocolors';

import { ConfigError } from '../config.js';
import { runClaude } from '../engine/claude.js';
import { BUILTIN_PROFILES, detectContext } from '../profiles.js';
import type { ReportMeta } from '../report/json.js';
import { renderTerminalReport } from '../report/terminal.js';
import { emitReports } from '../report/write.js';
import { runFixes } from '../review/fix.js';
import { gateExitCode } from '../review/gate.js';
import { type ReviewRunOutcome, runReview } from '../review/run.js';
import { TargetError, type TargetSpec, resolveRepoRoot } from '../review/targets.js';
import { type Severity, severities, severityRank } from '../schema.js';
import { collectAnswers, confirmFindings } from './interactive.js';
import { makeProgress, withProgress } from './progress.js';
import { parseSeverityOption } from './shared.js';

interface ReviewCliOptions {
  task?: string;
  taskFile?: string;
  failOn?: string;
  profile?: string;
  scope?: string;
  nonInteractive?: boolean;
  report?: string;
  reportMd?: string;
  fix?: boolean;
  yes?: boolean;
  /** Commander negation: --no-cache arrives as cache === false. */
  cache?: boolean;
}

/** Registers `agentlint review …` and the default bare-`agentlint` command. */
export function registerReview(program: Command): void {
  // The default command chain makes bare `agentlint` mean `review diff`:
  // the main verb of the tool must not require ceremony.
  const reviewCommand = program
    .command('review', { isDefault: true })
    .description('review a change (default command)');

  const reviewTarget = (name: string, description: string, isDefault = false): Command =>
    reviewCommand
      .command(name, { isDefault })
      .description(description)
      .option('--task <text>', 'what the change was supposed to do')
      .option('--task-file <path>', 'read the task description from a file')
      .option('--fail-on <severity>', `severity that blocks: ${severities.join(' | ')}`)
      .option(
        '--profile <name>',
        `profile: ${BUILTIN_PROFILES.join(' | ')} or a custom one (default: by context)`,
      )
      .option(
        '--scope <name|glob>',
        'restrict to a named scope, or an ad-hoc path glob like "src/**"',
      )
      .option('--non-interactive', 'never prompt; behave like a hook/CI run')
      .option('--no-cache', 'ignore the pass-verdict cache for this run')
      .option('--report <path>', 'also write a JSON report to this file, or "-" for JSON on stdout')
      .option('--report-md <path>', 'also write a Markdown report to this file');

  reviewTarget('diff', 'review uncommitted working-tree changes (default)', true)
    .option('--fix', 'apply confirmed fixes with a separate fixer run, then re-review once')
    .option('--yes', 'with --fix: fix all blocking findings without prompting')
    .action((opts: ReviewCliOptions) => executeDiffFlow(opts));

  reviewTarget('staged', 'review staged changes only').action((opts: ReviewCliOptions) =>
    execute({ kind: 'staged' }, opts),
  );

  reviewTarget('commit', 'review a commit (default: HEAD)')
    .argument('[ref]', 'commit to review', 'HEAD')
    .action((ref: string, opts: ReviewCliOptions) => execute({ kind: 'commit', ref }, opts));

  reviewTarget('range', 'review a commit range')
    .argument('<range>', 'range in the form a..b')
    .action((range: string, opts: ReviewCliOptions) => execute({ kind: 'range', range }, opts));

  reviewTarget('snapshot', 'review the whole project as it is now').action(
    (opts: ReviewCliOptions) => execute({ kind: 'snapshot' }, opts),
  );
}

/**
 * Escape hatch for hooks (like HUSKY=0): a blocked commit sometimes must
 * land anyway, and --no-verify skips every hook, not just this one.
 */
function skipRequested(): boolean {
  if (!process.env.AGENTLINT_SKIP || process.env.AGENTLINT_SKIP === '0') return false;
  console.log(pc.dim('agentlint skipped (AGENTLINT_SKIP is set).'));
  return true;
}

/** The default-command flow: review → optional fix + re-review. */
async function executeDiffFlow(opts: ReviewCliOptions): Promise<void> {
  if (skipRequested()) return;
  const target: TargetSpec = { kind: 'working-tree' };
  const task = await resolveTask(opts);
  const interactive = !opts.nonInteractive && Boolean(process.stdout.isTTY) && !process.env.CI;
  // Static flag validation belongs before the first paid engine call.
  if (opts.fix && !interactive && !opts.yes) {
    throw new ConfigError('--fix in a non-interactive run requires --yes.');
  }
  const jsonOnly = opts.report === '-';
  const runOpts = {
    cwd: process.cwd(),
    target,
    task,
    failOn: parseFailOn(opts.failOn),
    profile: opts.profile,
    scope: opts.scope,
    context: opts.nonInteractive ? detectContext(process.env, false) : detectContext(process.env),
    noCache: opts.cache === false,
  };

  const progress = makeProgress('agentlint review');
  let outcome = await withProgress(progress.label, () =>
    runReview({ ...runOpts, ...progress.hooks }),
  );
  if (outcome.kind === 'empty') {
    await reportEmpty(opts);
    return;
  }
  if (!jsonOnly) renderOutcome(outcome);
  let exitCode: number = gateExitCode(outcome.result);

  if (exitCode !== 0 && opts.fix) {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const answers = interactive ? await collectAnswers(outcome.result.questions) : [];
    const threshold = severityRank(outcome.failOn);
    const candidates = opts.yes
      ? outcome.result.findings.filter((f) => severityRank(f.severity) >= threshold)
      : outcome.result.findings;
    const confirmed = await confirmFindings(candidates, opts.yes ?? false);

    if (confirmed.length > 0) {
      // With --report -, stdout carries the JSON line and nothing else;
      // the fix narration is for humans only.
      if (!jsonOnly) console.log(pc.bold(`\nFixing ${confirmed.length} finding(s)...`));
      const fixResult = await withProgress('agentlint fix', () =>
        runFixes({
          engine: runClaude,
          repoRoot,
          findings: confirmed,
          model: 'sonnet',
          task,
          answers,
        }),
      );
      if (!jsonOnly) {
        console.log(`\n${fixResult.summary}\n`);
        console.log(pc.bold('Re-reviewing the fixed working tree...'));
      }

      const reProgress = makeProgress('agentlint re-review');
      outcome = await withProgress(reProgress.label, () =>
        runReview({ ...runOpts, ...reProgress.hooks }),
      );
      if (outcome.kind === 'empty') {
        // The fixer reverted the change entirely — nothing left to gate.
        await reportEmpty(opts, 'Nothing left to review after fixes.');
        return;
      }
      if (!jsonOnly) renderOutcome(outcome);
      exitCode = gateExitCode(outcome.result);
    } else if (!jsonOnly) {
      console.log(pc.dim('No findings confirmed; nothing to fix.'));
    }
  }

  await writeReports(outcome, opts);
  process.exitCode = exitCode;
}

async function execute(target: TargetSpec, opts: ReviewCliOptions): Promise<void> {
  if (skipRequested()) return;
  const task = await resolveTask(opts);
  const progress = makeProgress(`agentlint review (${target.kind})`);
  const outcome = await withProgress(progress.label, () =>
    runReview({
      cwd: process.cwd(),
      target,
      task,
      failOn: parseFailOn(opts.failOn),
      profile: opts.profile,
      scope: opts.scope,
      context: opts.nonInteractive ? detectContext(process.env, false) : detectContext(process.env),
      noCache: opts.cache === false,
      ...progress.hooks,
    }),
  );

  if (outcome.kind === 'empty') {
    await reportEmpty(opts);
    return;
  }

  if (opts.report !== '-') renderOutcome(outcome);
  await writeReports(outcome, opts);
  process.exitCode = gateExitCode(outcome.result);
}

/**
 * "Nothing to review" is still a result: a caller that passed --report must
 * get a current, stable "pass, nothing to review" file — never a missing file
 * or a stale one from a previous run. --report - writes it to stdout.
 */
async function reportEmpty(opts: ReviewCliOptions, message = 'Nothing to review.'): Promise<void> {
  if (opts.report !== '-') console.log(pc.dim(message));
  const empty = { verdict: 'pass' as const, summary: message, findings: [], questions: [] };
  const stdout = await emitReports(empty, { target: 'empty', costUsd: 0, durationMs: 0 }, opts);
  if (stdout) console.log(stdout);
  process.exitCode = 0;
}

function renderOutcome(outcome: Extract<ReviewRunOutcome, { kind: 'reviewed' }>): void {
  console.log(
    renderTerminalReport(outcome.result, {
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      profile: outcome.profile,
      refutedCount: outcome.refutedCount,
      cached: outcome.cached,
      runId: outcome.runId,
    }),
  );
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

async function writeReports(
  outcome: Extract<ReviewRunOutcome, { kind: 'reviewed' }>,
  opts: ReviewCliOptions,
): Promise<void> {
  const meta: ReportMeta = {
    target: outcome.target,
    profile: outcome.profile,
    refutedCount: outcome.refutedCount,
    cached: outcome.cached,
    costUsd: outcome.costUsd,
    durationMs: outcome.durationMs,
    runId: outcome.runId,
  };
  const stdout = await emitReports(outcome.result, meta, opts);
  if (stdout) console.log(stdout);
}
