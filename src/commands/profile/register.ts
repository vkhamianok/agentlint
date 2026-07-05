import { Command } from 'commander';
import pc from 'picocolors';

import { type EngineFn, resolveRun } from '../../engine/index.js';
import { resolveRepoRoot } from '../../review/targets.js';
import { withProgress } from '../progress.js';
import { configFilePath, generatorSettings } from '../shared.js';
import {
  type WrittenProfile,
  addProfile,
  editProfile,
  listProfiles,
  removeProfile,
} from './operations.js';

function printProfile(written: WrittenProfile): void {
  console.log(pc.green(`Wrote profile "${written.name}" to ${written.file}`) + '\n');
  console.log(JSON.stringify(written.entry, null, 2));
}

/** The engine and model that generate a profile — the standard profile's. */
async function profileGenerator(
  global: boolean | undefined,
): Promise<{ engine: EngineFn; model: string }> {
  const settings = await generatorSettings(global);
  const { engine, model } = await resolveRun({
    model: settings.model,
    weakEngine: settings.engine ?? process.env.AGENTLINT_ENGINE,
    tier: 'standard',
  });
  return { engine: engine.run, model };
}

/** Registers `agentlint profile add|edit|remove|list`. */
export function registerProfile(program: Command): void {
  const profileCommand = program.command('profile').description('manage review profiles');

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
        const gen = await profileGenerator(opts.global);
        const written = await withProgress('agentlint profile add', async () =>
          addProfile({
            engine: gen.engine,
            description: descriptionWords.join(' '),
            configPath: await configFilePath(opts.global),
            generatorModel: gen.model,
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
        const gen = await profileGenerator(opts.global);
        const written = await withProgress('agentlint profile edit', async () =>
          editProfile({
            engine: gen.engine,
            name,
            instruction: instructionWords.join(' '),
            configPath: await configFilePath(opts.global),
            generatorModel: gen.model,
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
}
