import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { type Severity, severities } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
  ignore: z.array(z.string()).optional(),
});

type ConfigFile = z.infer<typeof configFileSchema>;

export interface AgentlintConfig {
  /** Lowest severity that blocks the gate. */
  failOn: Severity;
  /** Hard cap on the size of the change sent for review. */
  maxDiffKb: number;
  /** Model per depth profile (profiles land in M4; standard is used now). */
  models: { quick: string; standard: string; deep: string };
  /** Globs excluded from review. Setting this REPLACES the defaults. */
  ignore: string[];
}

export const DEFAULT_CONFIG: AgentlintConfig = {
  failOn: 'blocker',
  maxDiffKb: 200,
  models: { quick: 'haiku', standard: 'sonnet', deep: 'opus' },
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
    ignore: file.ignore ?? acc.ignore,
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
