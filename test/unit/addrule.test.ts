import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { addRule } from '../../src/addrule.js';
import type { ClaudeEnvelope } from '../../src/engine/claude.js';
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
