import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { DEFAULT_CONFIG, loadConfig } from '../../config.js';
import { runClaude } from '../../engine/claude.js';
import { resolveRepoRoot } from '../../review/targets.js';
import { type Severity, severities } from '../../schema.js';
import { withProgress } from '../progress.js';
import { parseSeverityOption } from '../shared.js';
import { addRule, checkRules, editRule, listRules, removeRule } from './operations.js';

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

/** Registers `agentlint rule add|edit|list|check|remove`. */
export function registerRule(program: Command): void {
  const ruleCommand = program.command('rule').description('manage review rules');

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
}
