import { describe, expect, it } from 'vitest';

import {
  type Engine,
  type EngineDetector,
  EngineError,
  resolveRun,
} from '../../src/engine/index.js';

// A detector that reports a fixed set of engines as installed, by name.
const detectOnly =
  (...names: string[]): EngineDetector =>
  (engine: Engine) =>
    Promise.resolve(names.includes(engine.name));

const bothInstalled = detectOnly('claude', 'openai');

describe('resolveRun', () => {
  it('maps a tier to the chosen engine s model when none is pinned', async () => {
    expect(await resolveRun({ tier: 'quick', weakEngine: 'claude' })).toMatchObject({
      model: 'haiku',
    });
    expect(await resolveRun({ tier: 'deep', weakEngine: 'claude' })).toMatchObject({
      model: 'opus',
    });
    const codexDeep = await resolveRun({ tier: 'deep', weakEngine: 'openai' });
    expect(codexDeep.engine.name).toBe('openai');
    expect(codexDeep.model).toBe('gpt-5.5');
  });

  it('keeps an explicit bare model and routes it to its owning engine', async () => {
    const claude = await resolveRun({ model: 'opus', tier: 'quick' });
    expect(claude.engine.name).toBe('claude');
    expect(claude.model).toBe('opus');

    const codex = await resolveRun({ model: 'gpt-5.4', tier: 'quick' });
    expect(codex.engine.name).toBe('openai');
    expect(codex.model).toBe('gpt-5.4');
  });

  it('honours a provider:model prefix and strips it', async () => {
    const r = await resolveRun({ model: 'openai:gpt-5.5-mini', tier: 'standard' });
    expect(r.engine.name).toBe('openai');
    expect(r.model).toBe('gpt-5.5-mini');
  });

  it('lets --engine override the model provider, falling back to the tier model', async () => {
    // Profile pins a claude model, but --engine forces codex: the claude model
    // cannot cross engines, so codex s tier model is used instead.
    const r = await resolveRun({ model: 'opus', cliEngine: 'openai', tier: 'deep' });
    expect(r.engine.name).toBe('openai');
    expect(r.model).toBe('gpt-5.5');
  });

  it('lets an explicit model win over a weak engine hint', async () => {
    // config.engine says openai, but a profile pins a claude model.
    const r = await resolveRun({ model: 'sonnet', weakEngine: 'openai', tier: 'standard' });
    expect(r.engine.name).toBe('claude');
    expect(r.model).toBe('sonnet');
  });

  it('autodetects: one installed wins, both installed prefers claude', async () => {
    const codexOnly = await resolveRun({ tier: 'standard', detect: detectOnly('openai') });
    expect(codexOnly.engine.name).toBe('openai');
    expect(codexOnly.model).toBe('gpt-5.4');

    const both = await resolveRun({ tier: 'standard', detect: bothInstalled });
    expect(both.engine.name).toBe('claude');
    expect(both.model).toBe('sonnet');
  });

  it('routes the codex alias to the openai engine', async () => {
    const r = await resolveRun({ model: 'codex:gpt-5.4', tier: 'quick' });
    expect(r.engine.name).toBe('openai');
  });

  it('fails loudly on an unknown provider or engine', async () => {
    await expect(resolveRun({ model: 'gemini:pro', tier: 'quick' })).rejects.toThrow(EngineError);
    await expect(resolveRun({ model: 'gemini:pro', tier: 'quick' })).rejects.toThrow(
      /Unknown model provider/,
    );
    await expect(resolveRun({ cliEngine: 'gemini', tier: 'quick' })).rejects.toThrow(
      /Unknown engine/,
    );
  });
});
