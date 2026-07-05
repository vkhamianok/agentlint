import os from 'node:os';
import path from 'node:path';

import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../config.js';
import { type Severity, severities } from '../schema.js';
import { resolveRepoRoot } from '../targets.js';

/** The config file the profile and scope commands read and write. */
export async function configFilePath(global: boolean | undefined): Promise<string> {
  const dir = global ? os.homedir() : await resolveRepoRoot(process.cwd());
  return path.join(dir, '.agentlint', 'config.json');
}

/** The model that writes the generated text — the standard profile's. */
export async function generatorModel(global: boolean | undefined): Promise<string> {
  // --global runs outside any repo, so there is no project config to merge;
  // the shipped default is the right generation model there.
  if (global) return DEFAULT_CONFIG.profiles.standard.model;
  return (await loadConfig(await resolveRepoRoot(process.cwd()))).profiles.standard.model;
}

/** Validates a severity option value (--severity, --fail-on), or undefined. */
export function parseSeverityOption(value: string | undefined, flag: string): Severity | undefined {
  if (value === undefined) return undefined;
  if ((severities as readonly string[]).includes(value)) return value as Severity;
  throw new ConfigError(`Invalid ${flag} "${value}". Valid: ${severities.join(', ')}.`);
}
