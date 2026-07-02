import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeBinary, runClaude } from '../../src/engine/claude.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
  ExecaError: class ExecaError extends Error {},
}));

const { execa } = await import('execa');

describe('engine adapter', () => {
  afterEach(() => {
    delete process.env.AGENTLINT_CLAUDE_BIN;
    vi.clearAllMocks();
  });

  it('spawns "claude" from PATH by default', () => {
    expect(claudeBinary()).toBe('claude');
  });

  it('honors the AGENTLINT_CLAUDE_BIN override for tests', () => {
    process.env.AGENTLINT_CLAUDE_BIN = '/tmp/claude-stub';
    expect(claudeBinary()).toBe('/tmp/claude-stub');
  });

  it('passes the system prompt via a temp file, never argv, and cleans it up', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    let capturedArgs: string[] = [];
    let capturedContent = '';
    vi.mocked(execa).mockImplementationOnce(((_bin: string, args: string[]) => {
      capturedArgs = args;
      const fileIndex = args.indexOf('--append-system-prompt-file') + 1;
      capturedContent = readFileSync(args[fileIndex]!, 'utf8');
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' }),
        stderr: '',
      });
    }) as never);

    await runClaude({ prompt: 'x', appendSystemPrompt: 'RULES '.repeat(10_000) });

    expect(capturedArgs).toContain('--append-system-prompt-file');
    expect(capturedArgs).not.toContain('--append-system-prompt');
    expect(capturedContent).toContain('RULES');
    const fileIndex = capturedArgs.indexOf('--append-system-prompt-file') + 1;
    expect(existsSync(capturedArgs[fileIndex]!)).toBe(false); // cleaned up after the run
  });

  it('reports a timeout honestly instead of "is claude installed?"', async () => {
    const timeoutError = Object.assign(new Error('spawn timed out'), { timedOut: true });
    vi.mocked(execa).mockRejectedValueOnce(timeoutError as never);

    await expect(runClaude({ prompt: 'x', timeoutMs: 5000 })).rejects.toThrow(/timed out after 5s/);
  });

  it('still explains a missing binary as an install problem', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    vi.mocked(execa).mockRejectedValueOnce(enoent as never);

    await expect(runClaude({ prompt: 'x' })).rejects.toThrow(/Is Claude Code installed/);
  });
});
