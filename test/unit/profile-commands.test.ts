import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../src/config.js';
import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import {
  addProfile,
  editProfile,
  listProfiles,
  removeProfile,
} from '../../src/profile-commands.js';

function envelope(structuredOutput: unknown): ClaudeEnvelope {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(structuredOutput),
    structured_output: structuredOutput,
    total_cost_usd: 0.05,
  };
}

const generated = {
  name: 'audit',
  model: 'claude-fable-5',
  budgetUsd: 12,
  instructions: 'Hunt for injection and committed secrets.',
};

async function tmpConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-profile-'));
  return path.join(dir, '.agentlint', 'config.json');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'));
}

describe('addProfile', () => {
  it('generates a profile and writes it into a fresh config', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope(generated));

    const written = await addProfile({
      engine,
      description: 'security audit on the strongest model',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    expect(written.name).toBe('audit');
    const config = await readJson(configPath);
    expect((config.profiles as Record<string, unknown>).audit).toEqual({
      model: 'claude-fable-5',
      budgetUsd: 12,
      instructions: 'Hunt for injection and committed secrets.',
    });
    const call = engine.mock.calls[0]![0];
    expect(call.tools).toEqual([]);
    expect(call.prompt).toContain('security audit on the strongest model');
    expect(call.prompt).toContain('claude-fable-5'); // the exemplar
  });

  it('preserves other config keys when adding a profile', async () => {
    const configPath = await tmpConfig();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ failOn: 'warning', rules: ['library:errors'] }));
    const engine = vi.fn().mockResolvedValue(envelope(generated));

    await addProfile({
      engine,
      description: 'x',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    const config = await readJson(configPath);
    expect(config.failOn).toBe('warning');
    expect(config.rules).toEqual(['library:errors']);
    expect(config.profiles).toBeDefined();
  });

  it('forces the requested model and name over the generated ones', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope(generated));

    const written = await addProfile({
      engine,
      description: 'x',
      configPath,
      generatorModel: 'sonnet',
      model: 'opus',
      name: 'my-audit',
      cwd: path.dirname(configPath),
    });

    expect(written.name).toBe('my-audit');
    expect(written.entry.model).toBe('opus');
  });

  it('refuses to add a built-in profile name', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn();

    await expect(
      addProfile({
        engine,
        description: 'x',
        configPath,
        generatorModel: 'sonnet',
        name: 'quick',
        cwd: path.dirname(configPath),
      }),
    ).rejects.toThrow(/built-in/);
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses to add a name that already exists', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addProfile({
      engine,
      description: 'x',
      configPath,
      generatorModel: 'sonnet',
      name: 'audit',
      cwd: path.dirname(configPath),
    });

    await expect(
      addProfile({
        engine,
        description: 'x',
        configPath,
        generatorModel: 'sonnet',
        name: 'audit',
        cwd: path.dirname(configPath),
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects a generated model with shell metacharacters', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope({ ...generated, model: 'opus & calc.exe' }));

    await expect(
      addProfile({
        engine,
        description: 'x',
        configPath,
        generatorModel: 'sonnet',
        cwd: path.dirname(configPath),
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('editProfile', () => {
  it('rewrites an existing profile, sending the current entry to the editor', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addProfile({
      engine,
      description: 'x',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    engine.mockResolvedValueOnce(
      envelope({ model: 'opus', budgetUsd: 6, instructions: 'Narrower focus.' }),
    );
    const written = await editProfile({
      engine,
      name: 'audit',
      instruction: 'подешевле и уже',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    expect(written.entry).toMatchObject({ model: 'opus', budgetUsd: 6 });
    const call = engine.mock.calls[1]![0];
    expect(call.prompt).toContain('подешевле');
    expect(call.prompt).toContain('claude-fable-5'); // current entry embedded
  });

  it('seeds a first-time built-in edit with its real settings, not an empty object', async () => {
    const configPath = await tmpConfig();
    // Editing quick (built-in, no override yet) to only tweak instructions.
    const engine = vi
      .fn()
      .mockResolvedValue(
        envelope({ model: 'haiku', budgetUsd: 0.3, instructions: 'Blockers only, fast.' }),
      );

    const written = await editProfile({
      engine,
      name: 'quick',
      instruction: 'just add a note about speed',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    // The editor must see quick's real model/budget as the current profile,
    // not {} — so it cannot silently guess and replace them.
    const prompt = engine.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('haiku');
    expect(prompt).toContain('0.3');
    expect(written.entry.model).toBe('haiku');
  });

  it('errors when the profile does not exist', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn();

    await expect(
      editProfile({
        engine,
        name: 'nope',
        instruction: 'x',
        configPath,
        generatorModel: 'sonnet',
        cwd: path.dirname(configPath),
      }),
    ).rejects.toThrow(/not found/);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('removeProfile', () => {
  it('removes a custom profile and drops an empty profiles key', async () => {
    const configPath = await tmpConfig();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addProfile({
      engine,
      description: 'x',
      configPath,
      generatorModel: 'sonnet',
      cwd: path.dirname(configPath),
    });

    await removeProfile(configPath, 'audit');

    const config = await readJson(configPath);
    expect(config.profiles).toBeUndefined();
  });

  it('refuses to remove a built-in, and errors on a missing one', async () => {
    const configPath = await tmpConfig();
    await expect(removeProfile(configPath, 'quick')).rejects.toThrow(/built-in/);
    await expect(removeProfile(configPath, 'ghost')).rejects.toThrow(/not found/);
  });
});

describe('listProfiles', () => {
  it('lists built-ins plus custom, flagged by source and focus', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agentlint-plist-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(repo, '.agentlint'), { recursive: true });
    await writeFile(
      path.join(repo, '.agentlint', 'config.json'),
      JSON.stringify({ profiles: { audit: { model: 'claude-fable-5', instructions: 'x' } } }),
    );

    const listing = await listProfiles(repo, path.join(repo, 'no-home'));

    // Built-ins in tier order (quick → standard → deep) first, then custom.
    expect(listing.map((p) => p.name)).toEqual(['quick', 'standard', 'deep', 'audit']);

    const byName = Object.fromEntries(listing.map((p) => [p.name, p]));
    expect(byName.quick).toMatchObject({ source: 'built-in', hasInstructions: false });
    expect(byName.audit).toMatchObject({
      source: 'custom',
      model: 'claude-fable-5',
      hasInstructions: true,
    });
  });
});
