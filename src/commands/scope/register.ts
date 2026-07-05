import { Command } from 'commander';
import pc from 'picocolors';

import { resolveRepoRoot } from '../../review/targets.js';
import { configFilePath } from '../shared.js';
import { addScope, editScope, listScopes, removeScope } from './operations.js';

/** Registers `agentlint scope add|edit|remove|list`. */
export function registerScope(program: Command): void {
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
}
