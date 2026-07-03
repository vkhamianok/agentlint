import { readFile } from 'node:fs/promises';
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
const modelName = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/, 'model may only contain letters, digits, and . _ : -');

const profileName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'profile names are lower-case kebab, e.g. "audit"');

const profileOverrideSchema = z.strictObject({
  model: modelName.optional(),
  timeoutMinutes: z.number().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  /** Free-text focus appended to the reviewer's system prompt. */
  instructions: z.string().optional(),
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
  ignore: z.array(z.string()).optional(),
  rules: z
    .array(
      z.union([z.string(), z.strictObject({ rule: z.string(), severity: z.enum(severities) })]),
    )
    .optional(),
  inheritGlobalRules: z.boolean().optional(),
});

type ConfigFile = z.infer<typeof configFileSchema>;

export interface ProfileSettings {
  model: string;
  /** Hard wall-clock cap per review run. */
  timeoutMinutes: number;
  /** Hard spend cap per review run. */
  budgetUsd: number;
  /** Free-text focus appended to the reviewer's system prompt. */
  instructions?: string;
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
    };
  }
  return merged;
}

async function readConfigFile(file: string): Promise<ConfigFile | undefined> {
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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config ${file} is not valid JSON.`);
  }

  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    // A typo'd key or value silently ignored would mean config that never
    // takes effect — fail loudly, like the rules loader does.
    throw new ConfigError(`Invalid config ${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}
