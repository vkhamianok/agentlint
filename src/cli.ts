#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { ConfigError, DEFAULT_CONFIG, loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import { runFixes } from './fix.js';
import { gateExitCode } from './gate.js';
import { ignoreFinding, ignoreRun } from './ignore-commands.js';
import { initProject } from './init.js';
import { collectAnswers, confirmFindings } from './interactive.js';
import {
  type WrittenProfile,
  addProfile,
  editProfile,
  listProfiles,
  removeProfile,
} from './profile-commands.js';
import { BUILTIN_PROFILES, detectContext } from './profiles.js';
import type { ReportMeta } from './report/json.js';
import { renderTerminalReport } from './report/terminal.js';
import { emitReports } from './report/write.js';
import { type ReviewRunOutcome, runReview } from './review.js';
import { addRule, checkRules, editRule, listRules, removeRule } from './rule-commands.js';
import { RuleError } from './rules.js';
import { type Severity, severities, severityRank } from './schema.js';
import { addScope, editScope, listScopes, removeScope } from './scope-commands.js';
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
}

/**
 * Builds the label function and the runReview hooks that feed it. The label
 * grows in place: base → "· profile · model" once resolved → "· step" as the
 * reviewer works. Live steps only stream when stderr is a TTY, so agents and
 * hooks never trigger the streaming engine path.
 */
function makeProgress(base: string): {
  label: () => string;
  hooks: {
    onStart: (i: { profile: string; model: string }) => void;
    onStep?: (step: string) => void;
  };
} {
  let meta = '';
  let step = '';
  const onStep = process.stderr.isTTY
    ? (s: string): void => {
        step = ` · ${s}`;
      }
    : undefined;
  return {
    label: () => `${base}${meta}${step}`,
    hooks: {
      onStart: (i) => {
        meta = ` · ${i.profile} · ${i.model}`;
        step = '';
      },
      onStep,
    },
  };
}

/**
 * A ticking status line for the humans staring at an otherwise silent
 * minute-long engine run. stderr-only and TTY-gated: agents, hooks with
 * captured output, and CI see nothing — their contract (stdout + exit
 * code) is untouched.
 *
 * The label is a function so it can grow while the run proceeds — the
 * profile and model land once the review resolves them, and a live step as
 * the reviewer works.
 */
async function withProgress<T>(label: string | (() => string), work: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return work();
  const render = typeof label === 'function' ? label : () => label;
  const startedAt = Date.now();
  const tick = (): boolean =>
    process.stderr.write(
      `\r\x1b[2K${pc.dim(`${render()} · ${Math.round((Date.now() - startedAt) / 1000)}s`)}`,
    );
  const timer = setInterval(tick, 1000);
  tick();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K'); // clear the whole line, whatever its length
  }
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
    // No project config to read; the default standard model lives in one place.
    return {
      dir: path.join(os.homedir(), '.agentlint', 'rules'),
      model: DEFAULT_CONFIG.profiles.standard.model,
    };
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
      const rule = await withProgress('agentlint rule add', () =>
        addRule({
          engine: runClaude,
          description: descriptionWords.join(' '),
          targetDir: target.dir,
          model: target.model,
          severity: parseSeverityOption(opts.severity, '--severity'),
          name: opts.name,
          cwd: process.cwd(),
        }),
      );
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
      const rule = await withProgress('agentlint rule edit', () =>
        editRule({
          engine: runClaude,
          slug,
          instruction: instructionWords.join(' '),
          targetDir: target.dir,
          model: target.model,
          severity: parseSeverityOption(opts.severity, '--severity'),
          cwd: process.cwd(),
        }),
      );
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
  .command('check')
  .description('audit the rule set for contradictions, duplication, vagueness, and noise risks')
  .action(async () => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const model = (await loadConfig(repoRoot)).profiles.standard.model;
    const audit = await withProgress('agentlint rule check', () =>
      checkRules({ engine: runClaude, repoRoot, model }),
    );

    console.log(`\n${audit.summary}\n`);
    const kindColor: Record<string, (s: string) => string> = {
      contradiction: pc.red,
      duplication: pc.yellow,
      'noise-risk': pc.yellow,
      vagueness: pc.cyan,
      improvement: pc.cyan,
    };
    for (const finding of audit.findings) {
      const paint = kindColor[finding.kind] ?? pc.cyan;
      console.log(`${paint(pc.bold(finding.kind.toUpperCase()))}  ${finding.rules.join(', ')}`);
      console.log(`  ${finding.problem}`);
      console.log(`  ${pc.green('recommendation:')} ${finding.recommendation}\n`);
    }
    if (audit.findings.length === 0) {
      console.log(pc.green('No issues found in the rule set.'));
    }
  });

ruleCommand
  .command('remove')
  .description('remove a rule file')
  .argument('<slug>', 'rule file name without .md')
  .option('--global', 'remove from ~/.agentlint/rules instead of this project')
  .action(async (slug: string, opts: { global?: boolean }) => {
    const target = await ruleTarget(opts.global);
    const file = await removeRule(target.dir, slug);
    console.log(pc.green(`Removed ${file}`));
  });

const profileCommand = program.command('profile').description('manage review profiles');

/** The config file the profile and scope commands read and write. */
async function configFilePath(global: boolean | undefined): Promise<string> {
  const dir = global ? os.homedir() : await resolveRepoRoot(process.cwd());
  return path.join(dir, '.agentlint', 'config.json');
}

/** The model that writes the generated text — the standard profile's. */
async function generatorModel(global: boolean | undefined): Promise<string> {
  // --global runs outside any repo, so there is no project config to merge;
  // the shipped default is the right generation model there.
  if (global) return DEFAULT_CONFIG.profiles.standard.model;
  return (await loadConfig(await resolveRepoRoot(process.cwd()))).profiles.standard.model;
}

function printProfile(written: WrittenProfile): void {
  console.log(pc.green(`Wrote profile "${written.name}" to ${written.file}`) + '\n');
  console.log(JSON.stringify(written.entry, null, 2));
}

profileCommand
  .command('add')
  .description('generate a review profile from a plain-language description')
  .argument('<description...>', 'what the profile is for, in any language')
  .option('--global', 'write to ~/.agentlint/config.json instead of this project')
  .option('--model <model>', 'force the profile model instead of letting the generator pick')
  .option('--name <name>', 'kebab-case profile name (default: derived from the description)')
  .action(
    async (
      descriptionWords: string[],
      opts: { global?: boolean; model?: string; name?: string },
    ) => {
      const written = await withProgress('agentlint profile add', async () =>
        addProfile({
          engine: runClaude,
          description: descriptionWords.join(' '),
          configPath: await configFilePath(opts.global),
          generatorModel: await generatorModel(opts.global),
          model: opts.model,
          name: opts.name,
          cwd: process.cwd(),
        }),
      );
      printProfile(written);
    },
  );

profileCommand
  .command('edit')
  .description('rewrite an existing profile per a plain-language instruction')
  .argument('<name>', 'profile name')
  .argument('<instruction...>', 'what to change, in any language')
  .option('--global', 'edit in ~/.agentlint/config.json instead of this project')
  .option('--model <model>', 'force the profile model')
  .action(
    async (
      name: string,
      instructionWords: string[],
      opts: { global?: boolean; model?: string },
    ) => {
      const written = await withProgress('agentlint profile edit', async () =>
        editProfile({
          engine: runClaude,
          name,
          instruction: instructionWords.join(' '),
          configPath: await configFilePath(opts.global),
          generatorModel: await generatorModel(opts.global),
          model: opts.model,
          cwd: process.cwd(),
        }),
      );
      printProfile(written);
    },
  );

profileCommand
  .command('remove')
  .description('remove a custom profile (built-ins cannot be removed)')
  .argument('<name>', 'profile name')
  .option('--global', 'remove from ~/.agentlint/config.json instead of this project')
  .action(async (name: string, opts: { global?: boolean }) => {
    await removeProfile(await configFilePath(opts.global), name);
    console.log(pc.green(`Removed profile "${name}"`));
  });

profileCommand
  .command('list')
  .description('list the effective profiles: built-ins plus custom')
  .action(async () => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const profiles = await listProfiles(repoRoot);
    const nameWidth = Math.max(...profiles.map((p) => p.name.length));
    for (const p of profiles) {
      const focus = p.hasInstructions ? pc.cyan('custom focus') : pc.dim('general');
      console.log(
        `${pc.dim(p.source.padEnd(9))}  ${p.name.padEnd(nameWidth)}  ${p.model.padEnd(16)}  $${p.budgetUsd}  ${focus}`,
      );
    }
  });

const scopeCommand = program
  .command('scope')
  .description('manage named path filters for partial reviews (--scope)');

scopeCommand
  .command('add')
  .description('define a named scope from one or more path globs')
  .argument('<name>', 'scope name (lower-case kebab)')
  .argument('<glob...>', 'one or more path globs, e.g. "services/api/**"')
  .option('--global', 'write to ~/.agentlint/config.json instead of this project')
  .action(async (name: string, globs: string[], opts: { global?: boolean }) => {
    await addScope(await configFilePath(opts.global), name, globs);
    console.log(pc.green(`Added scope "${name}"`) + pc.dim(` — ${globs.join(', ')}`));
  });

scopeCommand
  .command('edit')
  .description('replace the globs of an existing scope')
  .argument('<name>', 'scope name')
  .argument('<glob...>', 'the new path globs (they replace the old ones)')
  .option('--global', 'edit in ~/.agentlint/config.json instead of this project')
  .action(async (name: string, globs: string[], opts: { global?: boolean }) => {
    await editScope(await configFilePath(opts.global), name, globs);
    console.log(pc.green(`Updated scope "${name}"`) + pc.dim(` — ${globs.join(', ')}`));
  });

scopeCommand
  .command('remove')
  .description('remove a named scope')
  .argument('<name>', 'scope name')
  .option('--global', 'remove from ~/.agentlint/config.json instead of this project')
  .action(async (name: string, opts: { global?: boolean }) => {
    await removeScope(await configFilePath(opts.global), name);
    console.log(pc.green(`Removed scope "${name}"`));
  });

scopeCommand
  .command('list')
  .description('list the scopes defined for this project')
  .action(async () => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const scopes = await listScopes(repoRoot);
    if (scopes.length === 0) {
      console.log(pc.dim('No scopes defined. Add one: agentlint scope add <name> <glob>.'));
      return;
    }
    const width = Math.max(...scopes.map((s) => s.name.length));
    for (const s of scopes) {
      console.log(`${s.name.padEnd(width)}  ${pc.dim(s.globs.join(', '))}`);
    }
  });

program
  .command('ignore')
  .description('dismiss a false-positive finding (or a whole run) with a reason')
  .argument('<id>', 'a finding id from the report, or a run id with --run')
  .argument('<reason...>', 'why it is safe to ignore — recorded for audit')
  .option('--run', 'ignore the whole run named by <id>, not a single finding')
  .action(async (id: string, reasonWords: string[], opts: { run?: boolean }) => {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const reason = reasonWords.join(' ');
    const res = opts.run
      ? await ignoreRun(repoRoot, id, reason)
      : await ignoreFinding(repoRoot, id, reason);
    console.log(pc.green(`Ignored ${res.scope} ${res.id}`) + pc.dim(` — ${res.title}`));
    console.log(
      res.verdict === 'pass'
        ? pc.dim('The run now passes; re-run the review (or retry the commit) to proceed.')
        : pc.dim('The run still blocks on other open findings; address or ignore those too.'),
    );
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
