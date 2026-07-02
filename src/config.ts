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

/** What a config file may contain — everything optional, unknown keys rejected. */
const configFileSchema = z.strictObject({
  failOn: z.enum(severities).optional(),
  maxDiffKb: z.number().positive().optional(),
  models: z
    .strictObject({
      quick: z.string().optional(),
      standard: z.string().optional(),
      deep: z.string().optional(),
    })
    .optional(),
  depth: z
    .strictObject({
      manual: depthEnum.optional(),
      hook: depthEnum.optional(),
      ci: depthEnum.optional(),
    })
    .optional(),
  timeoutMinutes: z
    .strictObject({
      quick: z.number().positive().optional(),
      standard: z.number().positive().optional(),
      deep: z.number().positive().optional(),
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

export interface AgentlintConfig {
  /** Lowest severity that blocks the gate. */
  failOn: Severity;
  /** Hard cap on the size of the change sent for review. */
  maxDiffKb: number;
  /** Model per depth profile. */
  models: { quick: string; standard: string; deep: string };
  /** Default depth per run context; --depth overrides. */
  depth: { manual: Depth; hook: Depth; ci: Depth };
  /** Hard wall-clock cap per review run, by profile. */
  timeoutMinutes: { quick: number; standard: number; deep: number };
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
  models: { quick: 'haiku', standard: 'sonnet', deep: 'opus' },
  depth: { manual: 'standard', hook: 'quick', ci: 'deep' },
  timeoutMinutes: { quick: 5, standard: 10, deep: 20 },
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
    models: {
      quick: file.models?.quick ?? acc.models.quick,
      standard: file.models?.standard ?? acc.models.standard,
      deep: file.models?.deep ?? acc.models.deep,
    },
    depth: {
      manual: file.depth?.manual ?? acc.depth.manual,
      hook: file.depth?.hook ?? acc.depth.hook,
      ci: file.depth?.ci ?? acc.depth.ci,
    },
    timeoutMinutes: {
      quick: file.timeoutMinutes?.quick ?? acc.timeoutMinutes.quick,
      standard: file.timeoutMinutes?.standard ?? acc.timeoutMinutes.standard,
      deep: file.timeoutMinutes?.deep ?? acc.timeoutMinutes.deep,
    },
    ignore: file.ignore ?? acc.ignore,
    rules: file.rules ?? acc.rules,
    inheritGlobalRules: file.inheritGlobalRules ?? acc.inheritGlobalRules,
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
