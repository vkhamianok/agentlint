import { Command } from 'commander';
import pc from 'picocolors';

import {
  ConfigError,
  type ConfigFile,
  SCOPE_NAME_PATTERN,
  loadConfig,
  readConfigObject,
  writeConfigObject,
} from '../config.js';
import { normalizeGlobs, resolveRepoRoot } from '../targets.js';
import { configFilePath } from './shared.js';

export interface ScopeListing {
  name: string;
  globs: string[];
}

/** Defines a named scope from one or more path globs. Fails if it already exists. */
export async function addScope(configPath: string, name: string, globs: string[]): Promise<void> {
  assertName(name);
  const clean = cleanGlobs(globs);
  const config = await readConfigObject(configPath);
  if (config.scopes?.[name]) {
    throw new ConfigError(`Scope "${name}" already exists. Use "scope edit" or pick another name.`);
  }
  await put(configPath, config, name, clean);
}

/** Replaces the globs of an existing scope. */
export async function editScope(configPath: string, name: string, globs: string[]): Promise<void> {
  const clean = cleanGlobs(globs);
  const config = await readConfigObject(configPath);
  if (!config.scopes?.[name]) throw notFound(name, config);
  await put(configPath, config, name, clean);
}

/** Removes a named scope. */
export async function removeScope(configPath: string, name: string): Promise<void> {
  const config = await readConfigObject(configPath);
  if (!config.scopes?.[name]) throw notFound(name, config);
  const rest = { ...config.scopes };
  delete rest[name];
  config.scopes = Object.keys(rest).length > 0 ? rest : undefined;
  await writeConfigObject(configPath, config);
}

/** The effective scopes for this project, sorted by name. */
export async function listScopes(repoRoot: string, homeDir?: string): Promise<ScopeListing[]> {
  const scopes = (await loadConfig(repoRoot, homeDir)).scopes;
  return Object.entries(scopes)
    .map(([name, globs]) => ({ name, globs }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function put(
  configPath: string,
  config: ConfigFile,
  name: string,
  globs: string[],
): Promise<void> {
  config.scopes = { ...config.scopes, [name]: globs };
  await writeConfigObject(configPath, config);
}

function assertName(name: string): void {
  if (!SCOPE_NAME_PATTERN.test(name)) {
    throw new ConfigError(`Scope names are lower-case kebab (e.g. "orchestrator"); got "${name}".`);
  }
}

// Trim, drop blanks, and normalize backslashes (Windows) so the config stores
// canonical forward-slash globs — the form git paths use.
function cleanGlobs(globs: string[]): string[] {
  const clean = normalizeGlobs(globs.map((g) => g.trim()).filter(Boolean));
  if (clean.length === 0) throw new ConfigError('A scope needs at least one path glob.');
  return clean;
}

function notFound(name: string, config: ConfigFile): ConfigError {
  const defined = Object.keys(config.scopes ?? {})
    .sort()
    .join(', ');
  return new ConfigError(`Scope "${name}" not found.${defined ? ` Defined: ${defined}.` : ''}`);
}

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
