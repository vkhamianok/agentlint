import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { Depth } from './profiles.js';
import type { RuleSelector } from './rules.js';
import { type Severity, severities } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const depthEnum = z.enum(['quick', 'standard', 'deep']);

const profileOverrideSchema = z.strictObject({
  model: z.string().optional(),
  timeoutMinutes: z.number().positive().optional(),
  budgetUsd: z.number().positive().optional(),
});

/** What a config file may contain — everything optional, unknown keys rejected. */
const configFileSchema = z.strictObject({
  failOn: z.enum(severities).optional(),
  maxDiffKb: z.number().positive().optional(),
  profiles: z
    .strictObject({
      quick: profileOverrideSchema.optional(),
      standard: profileOverrideSchema.optional(),
      deep: profileOverrideSchema.optional(),
    })
    .optional(),
  depth: z
    .strictObject({
      manual: depthEnum.optional(),
      hook: depthEnum.optional(),
      ci: depthEnum.optional(),
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
}

export interface AgentlintConfig {
  /** Lowest severity that blocks the gate. */
  failOn: Severity;
  /** Hard cap on the size of the change sent for review. */
  maxDiffKb: number;
  /** One settings object per depth profile. */
  profiles: { quick: ProfileSettings; standard: ProfileSettings; deep: ProfileSettings };
  /** Which profile each run context uses; --depth overrides. */
  depth: { manual: Depth; hook: Depth; ci: Depth };
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
  depth: { manual: 'standard', hook: 'quick', ci: 'deep' },
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
    profiles: {
      quick: mergeProfile(acc.profiles.quick, file.profiles?.quick),
      standard: mergeProfile(acc.profiles.standard, file.profiles?.standard),
      deep: mergeProfile(acc.profiles.deep, file.profiles?.deep),
    },
    depth: {
      manual: file.depth?.manual ?? acc.depth.manual,
      hook: file.depth?.hook ?? acc.depth.hook,
      ci: file.depth?.ci ?? acc.depth.ci,
    },
    ignore: file.ignore ?? acc.ignore,
    rules: file.rules ?? acc.rules,
    inheritGlobalRules: file.inheritGlobalRules ?? acc.inheritGlobalRules,
  };
}

function mergeProfile(
  acc: ProfileSettings,
  override: Partial<ProfileSettings> | undefined,
): ProfileSettings {
  return {
    model: override?.model ?? acc.model,
    timeoutMinutes: override?.timeoutMinutes ?? acc.timeoutMinutes,
    budgetUsd: override?.budgetUsd ?? acc.budgetUsd,
  };
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
