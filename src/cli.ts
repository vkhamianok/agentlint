#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { ConfigError, loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import { runFixes } from './fix.js';
import { gateExitCode } from './gate.js';
import { initProject } from './init.js';
import { collectAnswers, confirmFindings } from './interactive.js';
import { type Depth, depths, detectContext } from './profiles.js';
import { type ReportMeta, buildJsonReport } from './report/json.js';
import { renderMarkdownReport } from './report/markdown.js';
import { renderTerminalReport } from './report/terminal.js';
import { type ReviewRunOutcome, runReview } from './review.js';
import { addRule, deleteRule, editRule, listRules } from './rule-commands.js';
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
  /** Commander negation: --no-cache arrives as cache === false. */
  cache?: boolean;
}

// The default command chain makes bare `agentlint` mean `review diff`:
// the main verb of the tool must not require ceremony.
const reviewCommand = program
  .command('review', { isDefault: true })
  .description('review a change (default command)');

function reviewTarget(name: string, description: string, isDefault = false): Command {
  return reviewCommand
    .command(name, { isDefault })
    .description(description)
    .option('--task <text>', 'what the change was supposed to do')
    .option('--task-file <path>', 'read the task description from a file')
    .option('--fail-on <severity>', `severity that blocks: ${severities.join(' | ')}`)
    .option('--depth <depth>', `review depth: ${depths.join(' | ')} (default: by context)`)
    .option('--non-interactive', 'never prompt; behave like a hook/CI run')
    .option('--no-cache', 'ignore the pass-verdict cache for this run')
    .option('--report <path>', 'also write a JSON report to this file')
    .option('--report-md <path>', 'also write a Markdown report to this file');
}

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

reviewTarget('snapshot', 'review the whole project as it is now').action((opts: ReviewCliOptions) =>
  execute({ kind: 'snapshot' }, opts),
);

program
  .command('init')
  .description('set up agentlint in this repository (idempotent)')
  .option('--hook', 'also append the review gate to .husky/pre-commit')
  .action(async (opts: { hook?: boolean }) => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const steps = await initProject({ repoRoot, hook: Boolean(opts.hook) });

    for (const step of steps) {
      const badge =
        step.status === 'skipped' ? pc.dim(step.status) : pc.green(pc.bold(step.status));
      console.log(`${badge}  ${step.name} — ${step.detail}`);
    }

    console.log(
      [
        '',
        pc.bold('Next steps:'),
        '  npx agentlint                      review your uncommitted changes',
        '  npx agentlint rule add <text>      add a project rule in one sentence',
        ...(opts.hook
          ? []
          : ['  npx agentlint init --hook          gate every commit via husky pre-commit']),
      ].join('\n'),
    );
  });

const ruleCommand = program.command('rule').description('manage review rules');

/** Project rules dir + the model for generation, or the global equivalents. */
async function ruleTarget(global: boolean | undefined): Promise<{ dir: string; model: string }> {
  if (global) {
    return { dir: path.join(os.homedir(), '.agentlint', 'rules'), model: 'sonnet' };
  }
  const repoRoot = await resolveRepoRoot(process.cwd());
  return {
    dir: path.join(repoRoot, '.agentlint', 'rules'),
    model: (await loadConfig(repoRoot)).profiles.standard.model,
  };
}

ruleCommand
  .command('add')
  .description('generate a rule from a plain-language description')
  .argument('<description...>', 'what the rule should enforce, in any language')
  .option('--global', 'write to ~/.agentlint/rules instead of this project')
  .option('--severity <severity>', `force a severity: ${severities.join(' | ')}`)
  .option('--name <name>', 'kebab-case file name (default: derived from the rule)')
  .action(
    async (
      descriptionWords: string[],
      opts: { global?: boolean; severity?: string; name?: string },
    ) => {
      const target = await ruleTarget(opts.global);
      const rule = await addRule({
        engine: runClaude,
        description: descriptionWords.join(' '),
        targetDir: target.dir,
        model: target.model,
        severity: parseSeverityOption(opts.severity, '--severity'),
        name: opts.name,
        cwd: process.cwd(),
      });
      console.log(pc.green(`Created ${rule.file}`) + '\n');
      console.log(rule.content);
    },
  );

ruleCommand
  .command('edit')
  .description('rewrite an existing rule per a plain-language instruction')
  .argument('<slug>', 'rule file name without .md (see the error for available slugs)')
  .argument('<instruction...>', 'what to change, in any language')
  .option('--global', 'edit in ~/.agentlint/rules instead of this project')
  .option('--severity <severity>', `force a severity: ${severities.join(' | ')}`)
  .action(
    async (
      slug: string,
      instructionWords: string[],
      opts: { global?: boolean; severity?: string },
    ) => {
      const target = await ruleTarget(opts.global);
      const rule = await editRule({
        engine: runClaude,
        slug,
        instruction: instructionWords.join(' '),
        targetDir: target.dir,
        model: target.model,
        severity: parseSeverityOption(opts.severity, '--severity'),
        cwd: process.cwd(),
      });
      console.log(pc.green(`Updated ${rule.file}`) + '\n');
      console.log(rule.content);
    },
  );

ruleCommand
  .command('list')
  .description('list the rules a review of this project would use, in precedence order')
  .action(async () => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const rules = await listRules(repoRoot);
    if (rules.length === 0) {
      console.log(pc.dim('No rules enabled. Try: agentlint init, or agentlint rule add <text>.'));
      return;
    }

    const nameWidth = Math.max(...rules.map((r) => r.name.length));
    const severityColor: Record<Severity, (s: string) => string> = {
      blocker: pc.red,
      warning: pc.yellow,
      info: pc.cyan,
    };
    for (const rule of rules) {
      const severity = rule.severity
        ? severityColor[rule.severity](rule.severity.padEnd(7))
        : pc.dim('-'.padEnd(7));
      console.log(
        `${pc.dim(rule.source.padEnd(7))}  ${rule.name.padEnd(nameWidth)}  ${severity}  ${rule.title}`,
      );
    }
    console.log(pc.dim(`\n${rules.length} rules; later rules win when they conflict.`));
  });

ruleCommand
  .command('delete')
  .description('delete a rule file')
  .argument('<slug>', 'rule file name without .md')
  .option('--global', 'delete from ~/.agentlint/rules instead of this project')
  .action(async (slug: string, opts: { global?: boolean }) => {
    const target = await ruleTarget(opts.global);
    const file = await deleteRule(target.dir, slug);
    console.log(pc.green(`Deleted ${file}`));
  });

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
  const runOpts = {
    cwd: process.cwd(),
    target,
    task,
    failOn: parseFailOn(opts.failOn),
    depth: parseDepth(opts.depth),
    context: opts.nonInteractive ? detectContext(process.env, false) : detectContext(process.env),
    noCache: opts.cache === false,
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
      cached: outcome.cached,
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
    noCache: opts.cache === false,
  });

  if (outcome.kind === 'empty') {
    console.log(pc.dim('Nothing to review.'));
    process.exitCode = 0;
    return;
  }

  renderOutcome(outcome);
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
    cached: outcome.cached,
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
