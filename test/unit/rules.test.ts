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

async function addRule(root: string, name: string, content: string): Promise<void> {
  const dir = path.join(root, '.agentlint', 'rules');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content);
}

describe('loadPrinciples', () => {
  it('ships non-empty built-in principles', async () => {
    const principles = await loadPrinciples();
    expect(principles).toContain('Correctness');
    expect(principles).toContain('What NOT to report');
  });
});

describe('loadRules', () => {
  it('returns no rules when neither directory exists', async () => {
    const { home, repo } = await makeDirs();
    expect(await loadRules(repo, home)).toEqual([]);
  });

  it('loads project and global rules, global first', async () => {
    const { home, repo } = await makeDirs();
    await addRule(home, 'personal.md', 'Never use console.log in committed code.');
    await addRule(repo, 'db-layer.md', 'All DB access goes through repositories.');

    const rules = await loadRules(repo, home);

    expect(rules.map((r) => [r.source, r.name])).toEqual([
      ['global', 'personal'],
      ['project', 'db-layer'],
    ]);
    expect(rules[1]!.body).toBe('All DB access goes through repositories.');
  });

  it('parses severity and applies from frontmatter', async () => {
    const { home, repo } = await makeDirs();
    await addRule(
      repo,
      'scoped.md',
      '---\nseverity: blocker\napplies: "src/db/**"\n---\nNo raw SQL outside the repository layer.',
    );

    const [rule] = await loadRules(repo, home);

    expect(rule).toMatchObject({
      severity: 'blocker',
      applies: 'src/db/**',
      body: 'No raw SQL outside the repository layer.',
    });
  });

  it('skips rules with an empty body and non-md files', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'empty.md', '---\nseverity: info\n---\n   ');
    await addRule(repo, 'notes.txt', 'not a rule');

    expect(await loadRules(repo, home)).toEqual([]);
  });

  it('fails loudly on a misspelled severity', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'typo.md', '---\nseverity: blocking\n---\nSome rule.');

    await expect(loadRules(repo, home)).rejects.toThrow(RuleError);
  });

  it('fails loudly on a non-string applies scope', async () => {
    const { home, repo } = await makeDirs();
    await addRule(repo, 'scope.md', '---\napplies: 42\n---\nSome rule.');

    await expect(loadRules(repo, home)).rejects.toThrow(/must be a glob string/);
  });
});
