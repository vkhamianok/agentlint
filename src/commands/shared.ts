import os from 'node:os';
import path from 'node:path';

import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../config.js';
import { resolveRepoRoot } from '../review/targets.js';
import { type Severity, severities } from '../schema.js';

/** The config file the profile and scope commands read and write. */
export async function configFilePath(global: boolean | undefined): Promise<string> {
  const dir = global ? os.homedir() : await resolveRepoRoot(process.cwd());
  return path.join(dir, '.agentlint', 'config.json');
}

/** The model+engine that writes generated text — the standard profile's. */
export async function generatorSettings(
  global: boolean | undefined,
): Promise<{ model?: string; engine?: string }> {
  // --global runs outside any repo, so there is no project config to merge;
  // the shipped defaults are the right generation settings there.
  if (global) {
    return { model: DEFAULT_CONFIG.profiles.standard.model, engine: DEFAULT_CONFIG.engine };
  }
  const config = await loadConfig(await resolveRepoRoot(process.cwd()));
  return { model: config.profiles.standard.model, engine: config.engine };
}

/** Validates a severity option value (--severity, --fail-on), or undefined. */
export function parseSeverityOption(value: string | undefined, flag: string): Severity | undefined {
  if (value === undefined) return undefined;
  if ((severities as readonly string[]).includes(value)) return value as Severity;
  throw new ConfigError(`Invalid ${flag} "${value}". Valid: ${severities.join(', ')}.`);
}
