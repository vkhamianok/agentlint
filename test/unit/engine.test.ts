import { afterEach, describe, expect, it } from 'vitest';

import { claudeBinary } from '../../src/engine/claude.js';

describe('engine adapter', () => {
  afterEach(() => {
    delete process.env.AGENTLINT_CLAUDE_BIN;
  });

  it('spawns "claude" from PATH by default', () => {
    expect(claudeBinary()).toBe('claude');
  });

  it('honors the AGENTLINT_CLAUDE_BIN override for tests', () => {
    process.env.AGENTLINT_CLAUDE_BIN = '/tmp/claude-stub';
    expect(claudeBinary()).toBe('/tmp/claude-stub');
  });
});
