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

  it('merges models per key instead of replacing the object', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { models: { standard: 'opus' } });

    const config = await loadConfig(repo, home);

    expect(config.models).toEqual({ quick: 'haiku', standard: 'opus', deep: 'opus' });
  });

  it('merges depth per key instead of replacing the object', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { depth: { hook: 'deep' } });

    const config = await loadConfig(repo, home);

    expect(config.depth).toEqual({ manual: 'standard', hook: 'deep', ci: 'deep' });
  });

  it('merges timeoutMinutes per key', async () => {
    const { home, repo } = await makeDirs();
    await writeConfig(repo, { timeoutMinutes: { quick: 15 } });

    const config = await loadConfig(repo, home);

    expect(config.timeoutMinutes).toEqual({ quick: 15, standard: 10, deep: 20 });
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
