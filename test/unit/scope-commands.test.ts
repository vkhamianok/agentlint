import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/config.js';
import { addScope, editScope, listScopes, removeScope } from '../../src/scope-commands.js';

async function tmpConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-scope-'));
  return path.join(dir, '.agentlint', 'config.json');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'));
}

function scopes(config: Record<string, unknown>): Record<string, string[]> {
  return config.scopes as Record<string, string[]>;
}

describe('addScope', () => {
  it('creates a scope in a fresh config', async () => {
    const configPath = await tmpConfig();
    await addScope(configPath, 'orchestrator', ['services/orchestrator/**']);
    expect(scopes(await readJson(configPath)).orchestrator).toEqual(['services/orchestrator/**']);
  });

  it('preserves other config keys and trims blanks', async () => {
    const configPath = await tmpConfig();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ failOn: 'warning' }));

    await addScope(configPath, 'web', [' apps/web/** ', '', 'packages/ui/**']);

    const config = await readJson(configPath);
    expect(config.failOn).toBe('warning'); // untouched
    expect(scopes(config).web).toEqual(['apps/web/**', 'packages/ui/**']);
  });

  it('rejects a non-kebab name, an existing name, and empty globs', async () => {
    const configPath = await tmpConfig();
    await expect(addScope(configPath, 'Bad Name', ['a/**'])).rejects.toThrow(/kebab/);
    await expect(addScope(configPath, 'x', ['  ', ''])).rejects.toThrow(/at least one/);

    await addScope(configPath, 'dup', ['a/**']);
    await expect(addScope(configPath, 'dup', ['b/**'])).rejects.toThrow(/already exists/);
  });
});

describe('editScope', () => {
  it('replaces the globs of an existing scope, errors on a missing one', async () => {
    const configPath = await tmpConfig();
    await addScope(configPath, 'api', ['services/api/**']);

    await editScope(configPath, 'api', ['services/api/**', 'services/api-shared/**']);
    expect(scopes(await readJson(configPath)).api).toEqual([
      'services/api/**',
      'services/api-shared/**',
    ]);

    await expect(editScope(configPath, 'ghost', ['x/**'])).rejects.toThrow(/not found/);
  });
});

describe('removeScope', () => {
  it('removes a scope, dropping an empty scopes key, and errors on a missing one', async () => {
    const configPath = await tmpConfig();
    await addScope(configPath, 'only', ['a/**']);

    await removeScope(configPath, 'only');
    expect((await readJson(configPath)).scopes).toBeUndefined();

    await expect(removeScope(configPath, 'only')).rejects.toThrow(ConfigError);
  });
});

describe('listScopes', () => {
  it('lists the effective scopes, sorted by name', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agentlint-scopelist-'));
    await mkdir(path.join(repo, '.agentlint'), { recursive: true });
    await writeFile(
      path.join(repo, '.agentlint', 'config.json'),
      JSON.stringify({ scopes: { web: ['apps/web/**'], api: ['services/api/**'] } }),
    );

    const listing = await listScopes(repo, path.join(repo, 'no-home'));

    expect(listing).toEqual([
      { name: 'api', globs: ['services/api/**'] },
      { name: 'web', globs: ['apps/web/**'] },
    ]);
  });
});
