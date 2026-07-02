import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runReview } from '../../src/review.js';
import { git, makeRepo, write } from '../helpers/repo.js';

/**
 * The gate behavior contract, against the real claude CLI on the quick
 * profile. Costs real money: runs only with AGENTLINT_E2E=1. Asserts
 * verdicts, never exact wording.
 */
describe.skipIf(!process.env.AGENTLINT_E2E)('review e2e (real claude CLI)', () => {
  it('blocks a seeded logic bug with a deleted test', { timeout: 300_000 }, async () => {
    const repo = await makeRepo();
    await write(
      repo,
      'discount.js',
      '// Applies a discount. `percent` is a whole number 0-100.\n' +
        'export function applyDiscount(price, percent) {\n' +
        '  if (percent < 0 || percent > 100) throw new Error(`invalid percent: ${percent}`);\n' +
        '  return price * (1 - percent / 100);\n' +
        '}\n',
    );
    await write(
      repo,
      'discount.test.js',
      'import assert from "node:assert";\n' +
        'import { applyDiscount } from "./discount.js";\n' +
        'assert.strictEqual(applyDiscount(200, 25), 150);\n',
    );
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'discount module');
    await write(
      repo,
      'discount.js',
      '// Applies a discount. `percent` is a whole number 0-100.\n' +
        'export function applyDiscount(price, percent) {\n' +
        '  try {\n' +
        '    if (percent < 0 || percent > 100) throw new Error(`invalid percent: ${percent}`);\n' +
        '    return price * (1 - percent);\n' +
        '  } catch { return price; }\n' +
        '}\n',
    );
    await rm(path.join(repo, 'discount.test.js'));

    const outcome = await runReview({ cwd: repo, depth: 'quick' });

    if (outcome.kind !== 'reviewed') throw new Error('expected a review');
    expect(outcome.result.verdict).toBe('block');
    expect(outcome.result.findings.some((f) => f.severity === 'blocker')).toBe(true);
    expect(outcome.result.findings.every((f) => f.fixes.length > 0)).toBe(true);
  });

  it('passes an honest small change', { timeout: 300_000 }, async () => {
    const repo = await makeRepo();
    await write(
      repo,
      'hello.js',
      'export const hello = () => "hello";\n\n// Greets a person by name.\nexport const greet = (name) => "hello, " + name;\n',
    );

    const outcome = await runReview({ cwd: repo, depth: 'quick' });

    if (outcome.kind !== 'reviewed') throw new Error('expected a review');
    expect(outcome.result.verdict).toBe('pass');
  });

  it(
    'blocks a project-rule violation the base review would pass',
    { timeout: 300_000 },
    async () => {
      const repo = await makeRepo();
      const rulesDir = path.join(repo, '.agentlint', 'rules');
      await mkdir(rulesDir, { recursive: true });
      await writeFile(
        path.join(rulesDir, 'no-template-literals.md'),
        '---\nseverity: blocker\n---\nThis project forbids template literals (backtick strings). Flag every one introduced by the change.\n',
      );
      await write(
        repo,
        'hello.js',
        'export const hello = () => "hello";\n\n// Greets a person by name.\nexport const greet = (name) => `hello, ${name}`;\n',
      );

      const outcome = await runReview({ cwd: repo, depth: 'quick' });

      if (outcome.kind !== 'reviewed') throw new Error('expected a review');
      expect(outcome.result.verdict).toBe('block');
    },
  );
});
