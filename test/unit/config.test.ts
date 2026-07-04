import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../../src/config.js';

async function makeDirs(): Promise<{ home: string; repo: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agentlint-config-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  return { home, repo };
}

async function writeConfig(root: string, config: object): Promise<void> {
  const dir = path.join(root, '.agentlint');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
}

describe('loadConfig', () => {
  it('returns defaults when no config exists', async () => {
    const { home, repo } = await makeDirs();
    expect(await loadConfig(repo, home)).toEqual(DEFAULT_CONFIG);
  });

  it('merges global under project, project wins', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(home, { failOn: 'warning', maxDiffKb: 100 });
    await writeConfig(repo, { failOn: 'info' });

    const config = await loadConfig(repo, home);

    expect(config.failOn).toBe('info'); // project beats global
    expect(config.maxDiffKb).toBe(100); // global beats defaults
    expect(config.ignore).toEqual(DEFAULT_CONFIG.ignore); // untouched
  });

  it('merges profile overrides per field instead of replacing the object', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { profiles: { standard: { model: 'opus', budgetUsd: 3 } } });

    const config = await loadConfig(repo, home);

    expect(config.profiles.standard).toEqual({ model: 'opus', timeoutMinutes: 10, budgetUsd: 3 });
    expect(config.profiles.quick).toEqual(DEFAULT_CONFIG.profiles.quick); // untouched
  });

  it('merges defaultProfile per key instead of replacing the object', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { defaultProfile: { hook: 'deep' } });

    const config = await loadConfig(repo, home);

    expect(config.defaultProfile).toEqual({ manual: 'standard', hook: 'deep', ci: 'deep' });
  });

  it('adds a custom profile inheriting standard numbers, with its own model and instructions', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, {
      profiles: { audit: { model: 'claude-fable-5', budgetUsd: 10, instructions: 'Find vulns.' } },
    });

    const config = await loadConfig(repo, home);

    expect(config.profiles.audit).toEqual({
      model: 'claude-fable-5',
      timeoutMinutes: 10, // inherited from standard
      budgetUsd: 10,
      instructions: 'Find vulns.',
    });
    expect(config.profiles.standard).toEqual(DEFAULT_CONFIG.profiles.standard); // untouched
  });

  it('rejects a profile name that is not lower-case kebab', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { profiles: { Audit: { model: 'opus' } } });

    await expect(loadConfig(repo, home)).rejects.toThrow(ConfigError);
  });

  it('accepts rule selectors and inheritGlobalRules', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, {
      rules: [
        'library:structure',
        { rule: 'library:naming/self-descriptive-names', severity: 'info' },
      ],
      inheritGlobalRules: false,
    });

    const config = await loadConfig(repo, home);

    expect(config.rules).toEqual([
      'library:structure',
      { rule: 'library:naming/self-descriptive-names', severity: 'info' },
    ]);
    expect(config.inheritGlobalRules).toBe(false);
  });

  it('accepts a profile that overrides rules and opts out of project rules', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, {
      rules: ['library:errors'],
      profiles: {
        security: {
          model: 'claude-fable-5',
          rules: ['library:errors', './security/*.md'],
          inheritProjectRules: false,
        },
      },
    });

    const config = await loadConfig(repo, home);

    expect(config.profiles.security).toMatchObject({
      model: 'claude-fable-5',
      rules: ['library:errors', './security/*.md'],
      inheritProjectRules: false,
    });
    // The top-level rules are untouched; only the profile opts out.
    expect(config.rules).toEqual(['library:errors']);
  });

  it('merges scopes by name, project winning a clash', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(home, { scopes: { docs: ['documentation/**'], shared: ['libs/**'] } });
    await writeConfig(repo, {
      scopes: { orchestrator: ['services/orchestrator/**'], docs: ['docs/**'] },
    });

    const config = await loadConfig(repo, home);

    expect(config.scopes).toEqual({
      shared: ['libs/**'], // global-only survives
      orchestrator: ['services/orchestrator/**'], // project-only
      docs: ['docs/**'], // project wins the clash
    });
  });

  it('rejects a scope name that is not lower-case kebab', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { scopes: { Orchestrator: ['services/orchestrator/**'] } });

    await expect(loadConfig(repo, home)).rejects.toThrow(ConfigError);
  });

  it('rejects a model name carrying shell metacharacters', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { profiles: { standard: { model: 'sonnet & calc.exe' } } });

    await expect(loadConfig(repo, home)).rejects.toThrow(ConfigError);
  });

  it('fails loudly on unknown keys', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { failsOn: 'blocker' });

    await expect(loadConfig(repo, home)).rejects.toThrow(ConfigError);
  });

  it('fails loudly on invalid JSON', async () => {
    const { home, repo } = await makeDirs();
    const dir = path.join(repo, '.agentlint');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), '{ not json');

    await expect(loadConfig(repo, home)).rejects.toThrow(/not valid JSON/);
  });

  it('fails loudly on an invalid severity value', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { failOn: 'fatal' });

    await expect(loadConfig(repo, home)).rejects.toThrow(ConfigError);
  });
});
