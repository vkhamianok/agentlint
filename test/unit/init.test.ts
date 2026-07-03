import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../src/config.js';
import { initProject } from '../../src/init.js';
import { makeRepo } from '../helpers/repo.js';

const engineOk = vi.fn().mockResolvedValue('9.9.9 (Claude Code)');

describe('initProject', () => {
  it('creates the starter config and the rules directory readme', async () => {
    const repo = await makeRepo();

    const steps = await initProject({ repoRoot: repo, hook: false, checkEngine: engineOk });

    expect(steps.map((s) => s.status)).toEqual(['skipped', 'created', 'created']);
    const config = await readFile(path.join(repo, '.agentlint', 'config.json'), 'utf8');
    expect(JSON.parse(config).rules).toContain('library:root-cause');
    const readme = await readFile(path.join(repo, '.agentlint', 'rules', 'README.md'), 'utf8');
    expect(readme).toContain('rule add');
  });

  it('is idempotent and never rewrites an existing config', async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, '.agentlint'), { recursive: true });
    await writeFile(path.join(repo, '.agentlint', 'config.json'), '{ "failOn": "warning" }');

    const steps = await initProject({ repoRoot: repo, hook: false, checkEngine: engineOk });

    expect(steps.find((s) => s.name.endsWith('config.json'))?.status).toBe('skipped');
    const config = await readFile(path.join(repo, '.agentlint', 'config.json'), 'utf8');
    expect(config).toBe('{ "failOn": "warning" }'); // untouched
  });

  it('appends the hook line once, and only with --hook', async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    await writeFile(path.join(repo, '.husky', 'pre-commit'), 'pnpm test\n');

    const first = await initProject({ repoRoot: repo, hook: true, checkEngine: engineOk });
    expect(first.find((s) => s.name.includes('pre-commit'))?.status).toBe('updated');

    const second = await initProject({ repoRoot: repo, hook: true, checkEngine: engineOk });
    expect(second.find((s) => s.name.includes('pre-commit'))?.status).toBe('skipped');

    const hook = await readFile(path.join(repo, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toBe('pnpm test\nnpx agentlint review staged --profile quick\n');
  });

  it('points at husky setup when there is no pre-commit hook', async () => {
    const repo = await makeRepo();

    const steps = await initProject({ repoRoot: repo, hook: true, checkEngine: engineOk });

    const hookStep = steps.find((s) => s.name.includes('pre-commit'));
    expect(hookStep?.status).toBe('skipped');
    expect(hookStep?.detail).toContain('husky');
  });

  it('fails loudly when the claude CLI is unavailable', async () => {
    const repo = await makeRepo();
    const engineMissing = vi.fn().mockRejectedValue(new ConfigError('not found'));

    await expect(
      initProject({ repoRoot: repo, hook: false, checkEngine: engineMissing }),
    ).rejects.toThrow(ConfigError);
  });
});
