import { describe, expect, it } from 'vitest';

import { EngineError, resolveEngine } from '../../src/engine/index.js';

describe('resolveEngine', () => {
  it('defaults a bare model to claude, leaving the model whole', () => {
    expect(resolveEngine('opus')).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(resolveEngine('haiku-4.5')).toMatchObject({ provider: 'claude', model: 'haiku-4.5' });
    // A claude id without a colon is not mistaken for a provider prefix.
    expect(resolveEngine('claude-opus-4-8').model).toBe('claude-opus-4-8');
    expect(resolveEngine(undefined).provider).toBe('claude');
  });

  it('parses a provider:model prefix and strips it', () => {
    expect(resolveEngine('claude:opus')).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(resolveEngine('openai:gpt-5.5-mini')).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5-mini',
    });
  });

  it('routes openai and codex to one engine, distinct from claude', () => {
    const openai = resolveEngine('openai:x').engine;
    expect(resolveEngine('codex:y').engine).toBe(openai);
    expect(resolveEngine('claude:z').engine).not.toBe(openai);
  });

  it('fails loudly on an unknown provider', () => {
    expect(() => resolveEngine('gemini:pro')).toThrow(EngineError);
    expect(() => resolveEngine('gemini:pro')).toThrow(/Unknown model provider/);
  });
});
