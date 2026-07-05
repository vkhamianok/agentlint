import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { RuleSelector } from './rules.js';
import { type Severity, severities } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// A model name reaches the CLI as a spawn argument. Config is untrusted
// repository content, so restrict it to the characters real model aliases
// and full names use — no shell metacharacters can ride in through it.
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:-]+$/;
const modelName = z
  .string()
  .regex(MODEL_NAME_PATTERN, 'model may only contain letters, digits, and . _ : -');

export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const profileName = z
  .string()
  .regex(PROFILE_NAME_PATTERN, 'profile names are lower-case kebab, e.g. "audit"');

export const SCOPE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const scopeName = z
  .string()
  .regex(SCOPE_NAME_PATTERN, 'scope names are lower-case kebab, e.g. "orchestrator"');

// One config.rules / profile.rules entry: a selector string, or the object
// form that overrides the severity of whatever it selects.
const ruleSelectorSchema = z.union([
  z.string(),
  z.strictObject({ rule: z.string(), severity: z.enum(severities) }),
]);

const profileOverrideSchema = z.strictObject({
  model: modelName.optional(),
  timeoutMinutes: z.number().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  /** Free-text focus appended to the reviewer's system prompt. */
  instructions: z.string().optional(),
  /** Rule selectors this profile uses; added on top of config.rules. */
  rules: z.array(ruleSelectorSchema).optional(),
  /** When false, this profile ignores config.rules and the project rules dir. */
  inheritProjectRules: z.boolean().optional(),
  /** A scope name this profile restricts to by default; --scope overrides. */
  defaultScope: scopeName.optional(),
});

/** What a config file may contain — everything optional, unknown keys rejected. */
const configFileSchema = z.strictObject({
  failOn: z.enum(severities).optional(),
  maxDiffKb: z.number().positive().optional(),
  // An open set: the built-in quick/standard/deep can be tuned, and new
  // named profiles (e.g. a security "audit" on a stronger model) can be added.
  profiles: z.record(profileName, profileOverrideSchema).optional(),
  // Which profile each run context uses; values must name an existing profile.
  defaultProfile: z
    .strictObject({
      manual: z.string().optional(),
      hook: z.string().optional(),
      ci: z.string().optional(),
    })
    .optional(),
  // Named path filters for partial reviews: scope name → include globs.
  scopes: z.record(scopeName, z.array(z.string())).optional(),
  ignore: z.array(z.string()).optional(),
  rules: z.array(ruleSelectorSchema).optional(),
  inheritGlobalRules: z.boolean().optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

/**
 * The one validation path, shared by the loader and any writer, so a config
 * the loader would reject can never be written in the first place.
 */
export function parseConfigFile(json: unknown, file: string): ConfigFile {
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config ${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Reads and JSON-parses a config file, or undefined if it does not exist. */
export async function readConfigJson(file: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new ConfigError(
      `Cannot read config ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config ${file} is not valid JSON.`);
  }
}

/** Reads a config file into a validated object, or an empty one if absent. */
export async function readConfigObject(file: string): Promise<ConfigFile> {
  const json = await readConfigJson(file);
  if (json === undefined) return {}; // no config yet — start fresh
  return parseConfigFile(json, file);
}

/** Writes a config object, validating it first so a broken file is never written. */
export async function writeConfigObject(file: string, config: ConfigFile): Promise<void> {
  parseConfigFile(config, file); // never write a config the loader would reject
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export interface ProfileSettings {
  model: string;
  /** Hard wall-clock cap per review run. */
  timeoutMinutes: number;
  /** Hard spend cap per review run. */
  budgetUsd: number;
  /** Free-text focus appended to the reviewer's system prompt. */
  instructions?: string;
  /** Rule selectors this profile uses, on top of config.rules (see below). */
  rules?: RuleSelector[];
  /**
   * When false, the profile stands alone: config.rules and the project
   * .agentlint/rules directory are dropped, leaving only this profile's own
   * rules (and global rules, per inheritGlobalRules). Default true (additive).
   */
  inheritProjectRules?: boolean;
  /** A scope name this profile restricts to unless --scope overrides it. */
  defaultScope?: string;
}

export interface AgentlintConfig {
  /** Lowest severity that blocks the gate. */
  failOn: Severity;
  /** Hard cap on the size of the change sent for review. */
  maxDiffKb: number;
  /**
   * One settings object per named profile. The three built-ins are always
   * present (statically guaranteed); custom names live in the open record.
   */
  profiles: Record<string, ProfileSettings> & {
    quick: ProfileSettings;
    standard: ProfileSettings;
    deep: ProfileSettings;
  };
  /** Which profile each run context uses; --profile overrides. */
  defaultProfile: { manual: string; hook: string; ci: string };
  /** Named path filters: scope name → include globs, chosen with --scope. */
  scopes: Record<string, string[]>;
  /** Globs excluded from review. Setting this REPLACES the defaults. */
  ignore: string[];
  /**
   * Rule selectors ("library:structure", paths, globs, severity overrides).
   * Absent = load .agentlint/rules/ directories, the zero-config default.
   */
  rules?: RuleSelector[];
  /** Global ~/.agentlint rules apply unless set to false. */
  inheritGlobalRules: boolean;
}

export const DEFAULT_CONFIG: AgentlintConfig = {
  failOn: 'blocker',
  maxDiffKb: 200,
  profiles: {
    quick: { model: 'haiku', timeoutMinutes: 5, budgetUsd: 0.3 },
    standard: { model: 'sonnet', timeoutMinutes: 10, budgetUsd: 1.5 },
    deep: { model: 'opus', timeoutMinutes: 20, budgetUsd: 4 },
  },
  defaultProfile: { manual: 'standard', hook: 'quick', ci: 'deep' },
  scopes: {},
  inheritGlobalRules: true,
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/pnpm-lock.yaml',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/*.min.js',
    '**/*.min.css',
  ],
};

/** defaults ← global (~/.agentlint/config.json) ← project (.agentlint/config.json) */
export async function loadConfig(
  repoRoot: string,
  homeDir = os.homedir(),
): Promise<AgentlintConfig> {
  const global = await readConfigFile(path.join(homeDir, '.agentlint', 'config.json'));
  const project = await readConfigFile(path.join(repoRoot, '.agentlint', 'config.json'));
  return [global, project]
    .filter((c): c is ConfigFile => c !== undefined)
    .reduce(mergeConfig, DEFAULT_CONFIG);
}

function mergeConfig(acc: AgentlintConfig, file: ConfigFile): AgentlintConfig {
  return {
    failOn: file.failOn ?? acc.failOn,
    maxDiffKb: file.maxDiffKb ?? acc.maxDiffKb,
    profiles: mergeProfiles(acc.profiles, file.profiles),
    defaultProfile: {
      manual: file.defaultProfile?.manual ?? acc.defaultProfile.manual,
      hook: file.defaultProfile?.hook ?? acc.defaultProfile.hook,
      ci: file.defaultProfile?.ci ?? acc.defaultProfile.ci,
    },
    // Scopes merge by name (project wins a clash), so global and project can
    // each define their own — unlike ignore, which replaces wholesale.
    scopes: { ...acc.scopes, ...file.scopes },
    ignore: file.ignore ?? acc.ignore,
    rules: file.rules ?? acc.rules,
    inheritGlobalRules: file.inheritGlobalRules ?? acc.inheritGlobalRules,
  };
}

/**
 * A file's profiles tune the built-ins field-by-field and add new named
 * ones. A new profile inherits the standard profile's numbers, so a custom
 * entry can carry just a model and instructions and still be complete.
 */
function mergeProfiles(
  acc: AgentlintConfig['profiles'],
  overrides: Record<string, Partial<ProfileSettings>> | undefined,
): AgentlintConfig['profiles'] {
  const merged = { ...acc };
  for (const [name, override] of Object.entries(overrides ?? {})) {
    const base = acc[name] ?? acc.standard;
    merged[name] = {
      model: override.model ?? base.model,
      timeoutMinutes: override.timeoutMinutes ?? base.timeoutMinutes,
      budgetUsd: override.budgetUsd ?? base.budgetUsd,
      instructions: override.instructions ?? base.instructions,
      // Rule selection is the profile's own; a new custom profile does not
      // inherit standard's (standard has none), so it stays undefined there.
      rules: override.rules ?? acc[name]?.rules,
      inheritProjectRules: override.inheritProjectRules ?? acc[name]?.inheritProjectRules,
      defaultScope: override.defaultScope ?? acc[name]?.defaultScope,
    };
  }
  return merged;
}

async function readConfigFile(file: string): Promise<ConfigFile | undefined> {
  const json = await readConfigJson(file);
  if (json === undefined) return undefined;
  // A typo'd key or value silently ignored would mean config that never
  // takes effect — fail loudly, like the rules loader does.
  return parseConfigFile(json, file);
}
