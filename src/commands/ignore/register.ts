import { Command } from 'commander';
import pc from 'picocolors';

import { resolveRepoRoot } from '../../review/targets.js';
import { ignoreFinding, ignoreRun } from './operations.js';

/** Registers `agentlint ignore`. */
export function registerIgnore(program: Command): void {
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
}
