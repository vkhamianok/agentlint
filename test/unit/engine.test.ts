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
