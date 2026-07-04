import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RuleError, loadPrinciples, loadRules } from '../../src/rules.js';

async function makeDirs(): Promise<{ home: string; repo: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agentlint-rules-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  return { home, repo };
}

async function addRule(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, '.agentlint', 'rules', relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('loadPrinciples', () => {
  it('ships non-empty built-in principles', async () => {
    const principles = await loadPrinciples();
    expect(principles).toContain('Correctness');
    expect(principles).toContain('What NOT to report');
  });
});

describe('loadRules without selectors (directory convention)', () => {
  it('returns no rules when neither directory exists', async () => {
    const { home, repo } = await makeDirs();
    expect(await loadRules(repo, { homeDir: home })).toEqual([]);
  });

  it('loads global then project rules, recursing into subdirectories', async () => {
    const { home, repo } = await makeDirs();
    await addRule(home, 'personal.md', 'Never use console.log in committed code.');
    await addRule(repo, 'db/repository-layer.md', 'All DB access goes through repositories.');

    const rules = await loadRules(repo, { homeDir: home });

    expect(rules.map((r) => [r.source, r.name])).toEqual([
      ['global', 'personal'],
      ['project', 'db/repository-layer'],
    ]);
  });

  it('drops global rules when inheritGlobalRules is false', async () => {
    const { home, repo } = await makeDirs();
    await addRule(home, 'personal.md', 'Global taste.');
    await addRule(repo, 'local.md', 'Project law.');

    const rules = await loadRules(repo, { homeDir: home, inheritGlobalRules: false });

    expect(rules.map((r) => r.name)).toEqual(['local']);
  });

  it('parses severity and skips empty bodies and README.md', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'strict.md', '---\nseverity: blocker\n---\nNo raw SQL.');
    await addRule(repo, 'empty.md', '---\nseverity: info\n---\n   ');
    await addRule(repo, 'README.md', 'This directory holds our rules.');

    const rules = await loadRules(repo, { homeDir: home });

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'strict', severity: 'blocker', body: 'No raw SQL.' });
  });

  it('fails loudly on a misspelled severity and on unknown frontmatter keys', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'typo.md', '---\nseverity: blocking\n---\nSome rule.');
    await expect(loadRules(repo, { homeDir: home })).rejects.toThrow(RuleError);

    const { home: home2, repo: repo2 } = await makeDirs();
    await addRule(repo2, 'stale.md', '---\nseverity: info\napplies: "src/**"\n---\nSome rule.');
    await expect(loadRules(repo2, { homeDir: home2 })).rejects.toThrow(/Unknown frontmatter key/);
  });
});

describe('loadRules with selectors (config.rules)', () => {
  it('loads a whole library category with prefixed names', async () => {
    const { home, repo } = await makeDirs();

    const rules = await loadRules(repo, { homeDir: home, selectors: ['library:structure'] });

    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(rules.every((r) => r.source === 'library')).toBe(true);
    expect(rules.map((r) => r.name)).toContain('structure/single-source-of-truth');
  });

  it('loads a single library rule and applies severity overrides', async () => {
    const { home, repo } = await makeDirs();

    const rules = await loadRules(repo, {
      homeDir: home,
      selectors: [{ rule: 'library:naming/self-descriptive-names', severity: 'info' }],
    });

    expect(rules).toEqual([
      expect.objectContaining({ name: 'naming/self-descriptive-names', severity: 'info' }),
    ]);
  });

  it('rejects an unknown library spec with the available categories', async () => {
    const { home, repo } = await makeDirs();

    await expect(
      loadRules(repo, { homeDir: home, selectors: ['library:nonsense'] }),
    ).rejects.toThrow(/Unknown library rule "nonsense".*structure/);
  });

  it('loads project files by path and by glob', async () => {
    const { home, repo } = await makeDirs();
    await mkdir(path.join(repo, 'team-rules'), { recursive: true });
    await writeFile(path.join(repo, 'team-rules', 'one.md'), 'Rule one.');
    await writeFile(path.join(repo, 'team-rules', 'two.md'), 'Rule two.');

    const byPath = await loadRules(repo, { homeDir: home, selectors: ['team-rules/one.md'] });
    expect(byPath.map((r) => r.name)).toEqual(['team-rules/one']);

    const byGlob = await loadRules(repo, { homeDir: home, selectors: ['team-rules/*.md'] });
    expect(byGlob.map((r) => r.name).sort()).toEqual(['team-rules/one', 'team-rules/two']);
  });

  it('fails loudly when a path or glob matches nothing', async () => {
    const { home, repo } = await makeDirs();

    await expect(loadRules(repo, { homeDir: home, selectors: ['missing.md'] })).rejects.toThrow(
      /not found/,
    );
    await expect(
      loadRules(repo, { homeDir: home, selectors: ['team-rules/*.md'] }),
    ).rejects.toThrow(/No rule files match/);
  });

  it('always loads the project rules directory, last, even in selector mode', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'local.md', 'Project law.');

    const rules = await loadRules(repo, {
      homeDir: home,
      selectors: ['library:naming/self-descriptive-names'],
    });

    expect(rules.map((r) => [r.source, r.name])).toEqual([
      ['library', 'naming/self-descriptive-names'],
      ['project', 'local'],
    ]);
  });

  it('keeps global rules before selected ones', async () => {
    const { home, repo } = await makeDirs();
    await addRule(home, 'personal.md', 'Global taste.');

    const rules = await loadRules(repo, {
      homeDir: home,
      selectors: ['library:naming/self-descriptive-names'],
    });

    expect(rules.map((r) => r.source)).toEqual(['global', 'library']);
  });
});

describe('loadRules with profile selectors', () => {
  it('adds profile selectors on top of config.rules and the project dir', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'local.md', 'Project law.');

    const rules = await loadRules(repo, {
      homeDir: home,
      selectors: ['library:naming/self-descriptive-names'],
      profileSelectors: ['library:errors'],
    });

    // config.rules, then the profile's, then the always-on project dir.
    expect(rules.map((r) => r.name)).toContain('naming/self-descriptive-names');
    expect(rules.some((r) => r.name.startsWith('errors/'))).toBe(true);
    expect(rules.map((r) => [r.source, r.name])).toContainEqual(['project', 'local']);
  });

  it('inheritProjectRules:false drops config.rules and the project dir, keeping only the profile', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'local.md', 'Project law.');

    const rules = await loadRules(repo, {
      homeDir: home,
      selectors: ['library:naming/self-descriptive-names'],
      profileSelectors: ['library:errors'],
      inheritProjectRules: false,
    });

    // Only the profile's own rules survive — no config.rules, no project dir.
    expect(rules.every((r) => r.name.startsWith('errors/'))).toBe(true);
    expect(rules.some((r) => r.name === 'naming/self-descriptive-names')).toBe(false);
    expect(rules.some((r) => r.name === 'local')).toBe(false);
  });

  it('keeps global rules even when the profile stands alone', async () => {
    const { home, repo } = await makeDirs();
    await addRule(home, 'personal.md', 'Global taste.');

    const rules = await loadRules(repo, {
      homeDir: home,
      profileSelectors: ['library:errors'],
      inheritProjectRules: false,
    });

    // inheritProjectRules governs project-level rules only; global is separate.
    expect(rules.some((r) => r.source === 'global' && r.name === 'personal')).toBe(true);
  });
});
