import { Command } from 'commander';
import pc from 'picocolors';

import { resolveRepoRoot } from '../../review/targets.js';
import { initProject } from './operations.js';

/** Registers `agentlint init`. */
export function registerInit(program: Command): void {
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
}
