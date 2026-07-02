import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ClaudeEnvelope } from '../../src/engine/claude.js';
import { addRule, deleteRule, editRule } from '../../src/rule-commands.js';
import { RuleError } from '../../src/rules.js';

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

const goodBody = [
  '# Functions start with a verb',
  '',
  'Names carry intent; a function name without a verb hides what it does.',
  '',
  '## Flag',
  '',
  '- function or method names that are nouns (`userData()`, `config()`).',
  '',
  '## Do not flag',
  '',
  '- conventional accessors the project already uses.',
  '',
  '## Examples',
  '',
  '### Bad',
  '',
  '```js',
  'function userList(db) {}',
  '```',
  '',
  '### Good',
  '',
  '```js',
  'function loadUserList(db) {}',
  '```',
].join('\n');

const generated = { name: 'verb-function-names', severity: 'warning', body: goodBody };

async function makeTarget(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentlint-addrule-'));
}

describe('addRule', () => {
  it('writes a frontmattered, format-checked rule file and returns it', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));

    const rule = await addRule({
      engine,
      description: 'все методы и функции должны начинаться с глагола',
      targetDir,
      model: 'sonnet',
      cwd: targetDir,
    });

    expect(rule.file).toBe(path.join(targetDir, 'verb-function-names.md'));
    const onDisk = await readFile(rule.file, 'utf8');
    expect(onDisk).toContain('severity: warning');
    expect(onDisk).toContain('# Functions start with a verb');

    const call = engine.mock.calls[0]![0];
    expect(call.tools).toEqual([]);
    expect(call.prompt).toContain('начинаться с глагола');
    expect(call.prompt).toContain('# Self-descriptive names'); // the exemplar
    expect(call.prompt).toContain('Choose the severity yourself');
  });

  it('forces the requested severity and file name over the generated ones', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));

    const rule = await addRule({
      engine,
      description: 'functions start with a verb',
      targetDir,
      model: 'sonnet',
      severity: 'blocker',
      name: 'my-verbs',
      cwd: targetDir,
    });

    expect(rule.file).toBe(path.join(targetDir, 'my-verbs.md'));
    expect(rule.content).toContain('severity: blocker');
    expect(engine.mock.calls[0]![0].prompt).toContain('Use severity: blocker');
  });

  it('refuses to overwrite an existing rule file', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir });

    await expect(
      addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects a malformed generation instead of writing a broken file', async () => {
    const targetDir = await makeTarget();
    const engine = vi
      .fn()
      .mockResolvedValue(envelope({ ...generated, body: '# Title only, no sections' }));

    await expect(
      addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir }),
    ).rejects.toThrow(/missing the "## Flag" section/);
  });

  it('edits an existing rule in place, sending the current text to the editor', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir });

    const editedBody = goodBody.replace('Names carry intent', 'Names carry design intent');
    engine.mockResolvedValueOnce(envelope({ severity: 'blocker', body: editedBody }));
    const rule = await editRule({
      engine,
      slug: 'verb-function-names',
      instruction: 'подними до блокера и усиль формулировку',
      targetDir,
      model: 'sonnet',
      cwd: targetDir,
    });

    expect(rule.file).toBe(path.join(targetDir, 'verb-function-names.md'));
    const onDisk = await readFile(rule.file, 'utf8');
    expect(onDisk).toContain('severity: blocker');
    expect(onDisk).toContain('Names carry design intent');

    const call = engine.mock.calls[1]![0];
    expect(call.prompt).toContain('подними до блокера');
    expect(call.prompt).toContain('# Functions start with a verb'); // current rule embedded
  });

  it('rejects a malformed edit instead of destroying the existing file', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir });
    const before = await readFile(path.join(targetDir, 'verb-function-names.md'), 'utf8');

    engine.mockResolvedValueOnce(envelope({ severity: 'warning', body: '# Gutted rule' }));
    await expect(
      editRule({
        engine,
        slug: 'verb-function-names',
        instruction: 'x',
        targetDir,
        model: 'sonnet',
        cwd: targetDir,
      }),
    ).rejects.toThrow(/missing the "## Flag" section/);

    const after = await readFile(path.join(targetDir, 'verb-function-names.md'), 'utf8');
    expect(after).toBe(before); // untouched
  });

  it('names the available slugs when the target rule does not exist', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir });

    await expect(
      editRule({
        engine,
        slug: 'no-such-rule',
        instruction: 'x',
        targetDir,
        model: 'sonnet',
        cwd: targetDir,
      }),
    ).rejects.toThrow(/Available: verb-function-names/);
  });

  it('refuses slugs that escape the rules directory', async () => {
    const targetDir = await makeTarget();
    await expect(deleteRule(targetDir, '../outside')).rejects.toThrow(/Invalid rule slug/);
  });

  it('deletes an existing rule and errors loudly on a missing one', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn().mockResolvedValue(envelope(generated));
    await addRule({ engine, description: 'x', targetDir, model: 'sonnet', cwd: targetDir });

    const file = await deleteRule(targetDir, 'verb-function-names');
    expect(file).toBe(path.join(targetDir, 'verb-function-names.md'));
    await expect(readFile(file, 'utf8')).rejects.toThrow();

    await expect(deleteRule(targetDir, 'verb-function-names')).rejects.toThrow(/not found/);
  });

  it('lists the effective rule set with sources, severities, and titles', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const repo = await makeTarget();
    await mkdir(path.join(repo, '.agentlint', 'rules'), { recursive: true });
    await writeFile(
      path.join(repo, '.agentlint', 'config.json'),
      '{ "rules": ["library:naming/self-descriptive-names"], "inheritGlobalRules": false }',
    );
    await writeFile(
      path.join(repo, '.agentlint', 'rules', 'local-law.md'),
      '---\nseverity: blocker\n---\n\n# Local law\n\nBody.',
    );

    const { listRules } = await import('../../src/rule-commands.js');
    const listing = await listRules(repo, path.join(repo, 'no-home'));

    expect(listing).toEqual([
      {
        source: 'library',
        name: 'naming/self-descriptive-names',
        severity: 'warning',
        title: 'Self-descriptive names',
      },
      { source: 'project', name: 'local-law', severity: 'blocker', title: 'Local law' },
    ]);
  });

  it('rejects a non-kebab-case --name before spending money', async () => {
    const targetDir = await makeTarget();
    const engine = vi.fn();

    await expect(
      addRule({
        engine,
        description: 'x',
        targetDir,
        model: 'sonnet',
        name: 'Bad Name',
        cwd: targetDir,
      }),
    ).rejects.toThrow(RuleError);
    expect(engine).not.toHaveBeenCalled();
  });
});
