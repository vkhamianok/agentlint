import { Command } from 'commander';
import pc from 'picocolors';
import { z } from 'zod';

import {
  ConfigError,
  type ConfigFile,
  DEFAULT_CONFIG,
  MODEL_NAME_PATTERN,
  PROFILE_NAME_PATTERN,
  loadConfig,
  readConfigObject,
  writeConfigObject,
} from '../config.js';
import { runClaude } from '../engine/claude.js';
import { BUILTIN_PROFILES } from '../profiles.js';
import type { EngineFn } from '../review.js';
import type { RuleSelector } from '../rules.js';
import { toCliJsonSchema } from '../schema.js';
import { resolveRepoRoot } from '../targets.js';
import { withProgress } from './progress.js';
import { configFilePath, generatorModel } from './shared.js';

const BUILTINS: readonly string[] = BUILTIN_PROFILES;

/** A profile entry as it lives in .agentlint/config.json's profiles map. */
export interface ProfileEntry {
  model?: string;
  timeoutMinutes?: number;
  budgetUsd?: number;
  instructions?: string;
  /** Rule selectors are set by hand; edit/add must carry them through untouched. */
  rules?: RuleSelector[];
  inheritProjectRules?: boolean;
  defaultScope?: string;
}

export interface WrittenProfile {
  name: string;
  entry: ProfileEntry;
  file: string;
}

const generatedProfileSchema = z.looseObject({
  name: z
    .string()
    .regex(PROFILE_NAME_PATTERN)
    .describe('short kebab-case profile name, e.g. "audit" or "security"'),
  model: z
    .string()
    .regex(MODEL_NAME_PATTERN)
    .describe('model for the job: alias haiku|sonnet|opus|fable, or a full id like claude-fable-5'),
  budgetUsd: z
    .number()
    .positive()
    .describe('hard spend cap per run, sized to thoroughness: light ~1, a thorough audit ~8-12'),
  instructions: z
    .string()
    .describe('the review focus this profile appends to the prompt: what it looks for, concretely'),
});
const generatedProfileJsonSchema = toCliJsonSchema(generatedProfileSchema);

const editedProfileSchema = generatedProfileSchema.omit({ name: true });
const editedProfileJsonSchema = toCliJsonSchema(editedProfileSchema);

/** Generates a profile from a plain-language description and writes it into the config. */
export async function addProfile(opts: {
  engine: EngineFn;
  description: string;
  configPath: string;
  /** Model that runs the generation (the project's standard model). */
  generatorModel: string;
  /** Force the generated profile's model / name instead of letting the generator pick. */
  model?: string;
  name?: string;
  cwd: string;
}): Promise<WrittenProfile> {
  if (opts.name && !PROFILE_NAME_PATTERN.test(opts.name)) {
    throw new ConfigError(`--name must be lower-case kebab, got "${opts.name}".`);
  }
  const config = await readConfigObject(opts.configPath);
  if (opts.name) assertAddable(opts.name, config);

  const envelope = await opts.engine({
    prompt: buildGeneratorPrompt(opts.description, opts.model),
    jsonSchema: generatedProfileJsonSchema,
    tools: [],
    model: opts.generatorModel,
    maxTurns: 4,
    maxBudgetUsd: 0.3,
    timeoutMs: 3 * 60 * 1000,
    cwd: opts.cwd,
  });
  const parsed = generatedProfileSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new ConfigError(`The generator did not return a valid profile: ${parsed.error.message}`);
  }

  const name = opts.name ?? parsed.data.name;
  assertAddable(name, config);
  const entry: ProfileEntry = {
    model: opts.model ?? parsed.data.model,
    budgetUsd: parsed.data.budgetUsd,
    instructions: parsed.data.instructions.trim(),
  };
  await writeProfile(opts.configPath, config, name, entry);
  return { name, entry, file: opts.configPath };
}

/** Rewrites an existing profile per a plain-language instruction. */
export async function editProfile(opts: {
  engine: EngineFn;
  name: string;
  instruction: string;
  configPath: string;
  generatorModel: string;
  model?: string;
  cwd: string;
}): Promise<WrittenProfile> {
  const config = await readConfigObject(opts.configPath);
  const existing = config.profiles?.[opts.name];
  if (!BUILTINS.includes(opts.name) && !existing) {
    throw new ConfigError(
      `Profile "${opts.name}" not found.${availableHint(config)} Add it with "profile add".`,
    );
  }
  // A built-in with no override yet still has real settings (model, budget)
  // in the defaults — seed the editor with those so a first tweak does not
  // let the generator guess model/budget from nothing and overwrite them.
  const current = existing ?? DEFAULT_CONFIG.profiles[opts.name] ?? {};

  const envelope = await opts.engine({
    prompt: buildEditorPrompt(opts.name, current, opts.instruction, opts.model),
    jsonSchema: editedProfileJsonSchema,
    tools: [],
    model: opts.generatorModel,
    maxTurns: 4,
    maxBudgetUsd: 0.3,
    timeoutMs: 3 * 60 * 1000,
    cwd: opts.cwd,
  });
  const parsed = editedProfileSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new ConfigError(`The editor did not return a valid profile: ${parsed.error.message}`);
  }

  const entry: ProfileEntry = {
    ...existing,
    model: opts.model ?? parsed.data.model,
    budgetUsd: parsed.data.budgetUsd,
    instructions: parsed.data.instructions.trim(),
  };
  await writeProfile(opts.configPath, config, opts.name, entry);
  return { name: opts.name, entry, file: opts.configPath };
}

/** Removes a custom profile from the config. Built-ins cannot be removed. */
export async function removeProfile(configPath: string, name: string): Promise<void> {
  if (BUILTINS.includes(name)) {
    throw new ConfigError(`"${name}" is a built-in profile and cannot be removed.`);
  }
  const config = await readConfigObject(configPath);
  if (!config.profiles?.[name]) {
    throw new ConfigError(`Profile "${name}" not found.${availableHint(config)}`);
  }
  const rest = { ...config.profiles };
  delete rest[name];
  config.profiles = Object.keys(rest).length > 0 ? rest : undefined;
  await writeConfigObject(configPath, config);
}

export interface ProfileListing {
  name: string;
  source: 'built-in' | 'custom';
  model: string;
  budgetUsd: number;
  hasInstructions: boolean;
}

/** The effective profile set — built-ins plus custom, tuned by config. */
export async function listProfiles(repoRoot: string, homeDir?: string): Promise<ProfileListing[]> {
  const config = await loadConfig(repoRoot, homeDir);
  return Object.entries(config.profiles)
    .map(([name, settings]) => ({
      name,
      source: (BUILTINS.includes(name) ? 'built-in' : 'custom') as 'built-in' | 'custom',
      model: settings.model,
      budgetUsd: settings.budgetUsd,
      hasInstructions: Boolean(settings.instructions),
    }))
    .sort((a, b) => builtinRank(a.name) - builtinRank(b.name) || a.name.localeCompare(b.name));
}

// Built-ins first in their quick → standard → deep progression (increasing
// thoroughness), then custom profiles alphabetically — instead of one flat
// alphabetical list that interleaves the two and scrambles the built-in order.
function builtinRank(name: string): number {
  const i = BUILTINS.indexOf(name);
  return i === -1 ? BUILTINS.length : i;
}

function assertAddable(name: string, config: ConfigFile): void {
  if (BUILTINS.includes(name)) {
    throw new ConfigError(`"${name}" is a built-in profile; tune it with "profile edit", not add.`);
  }
  if (config.profiles?.[name]) {
    throw new ConfigError(
      `Profile "${name}" already exists. Use "profile edit" or pick another name.`,
    );
  }
}

function availableHint(config: ConfigFile): string {
  const custom = Object.keys(config.profiles ?? {}).filter((n) => !BUILTINS.includes(n));
  return custom.length > 0 ? ` Custom profiles: ${custom.sort().join(', ')}.` : '';
}

const EXEMPLAR = `{
  "model": "claude-fable-5",
  "budgetUsd": 12,
  "instructions": "Audit for security: injection (shell, SQL, path), secrets committed to code, unvalidated input at trust boundaries, unsafe deserialization, and untrusted data reaching a spawn or eval."
}`;

function buildGeneratorPrompt(description: string, forcedModel: string | undefined): string {
  return [
    'Design ONE agentlint review profile from the description below. A profile is a named review preset: a model, a per-run budget, and free-text "instructions" that focus what the reviewer looks for.',
    `## What the profile is for (any language; write the instructions in English)\n\n${description}`,
    forcedModel
      ? `Use model: ${forcedModel}.`
      : 'Choose the model by the job: "haiku" fast/cheap, "sonnet" balanced, "opus" most thorough, "fable" strongest for security and deep analysis (pricier). Use an alias or a full id.',
    'Size budgetUsd to thoroughness: a light per-commit profile ~0.5-1, a thorough one-off audit ~8-12.',
    'Write "instructions" as a focused, concrete review lens — the specific things to hunt for — not a vague mission statement.',
    `## Example of a good profile\n\n\`\`\`json\n${EXEMPLAR}\n\`\`\``,
    'Call the StructuredOutput tool with: name (kebab-case), model, budgetUsd, and instructions.',
  ].join('\n\n');
}

function buildEditorPrompt(
  name: string,
  current: ProfileEntry,
  instruction: string,
  forcedModel: string | undefined,
): string {
  return [
    `Revise the agentlint profile "${name}" per the instruction. Change only what it asks; keep the rest.`,
    `## Instruction (any language; instructions stay in English)\n\n${instruction}`,
    forcedModel ? `Use model: ${forcedModel}.` : '',
    `## Current profile\n\n\`\`\`json\n${JSON.stringify(current, null, 2)}\n\`\`\``,
    'Call the StructuredOutput tool with the revised model, budgetUsd, and instructions.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function writeProfile(
  configPath: string,
  config: ConfigFile,
  name: string,
  entry: ProfileEntry,
): Promise<void> {
  config.profiles = { ...config.profiles, [name]: entry };
  await writeConfigObject(configPath, config);
}

function printProfile(written: WrittenProfile): void {
  console.log(pc.green(`Wrote profile "${written.name}" to ${written.file}`) + '\n');
  console.log(JSON.stringify(written.entry, null, 2));
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
}
