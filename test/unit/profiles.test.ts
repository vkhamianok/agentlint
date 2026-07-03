import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config.js';
import { detectContext, resolveProfile } from '../../src/profiles.js';

describe('resolveProfile', () => {
  it('quick: cheap model, single-shot without tools, blocker focus', () => {
    const profile = resolveProfile('quick', DEFAULT_CONFIG);
    expect(profile.model).toBe('haiku');
    expect(profile.tools).toEqual([]); // no exploration: hook latency must be predictable
    expect(profile.maxTurns).toBeLessThanOrEqual(4);
    expect(profile.maxDiffKb).toBe(64); // tighter than the 200 KB config default
    expect(profile.promptFocus).toContain('pre-commit gate');
    expect(profile.refute).toBe(false);
    expect(profile.maxBudgetUsd).toBeLessThan(1);
  });

  it('takes model, timeout, and budget from the profile settings', () => {
    expect(resolveProfile('quick', DEFAULT_CONFIG).timeoutMs).toBe(5 * 60 * 1000);
    expect(resolveProfile('standard', DEFAULT_CONFIG).maxBudgetUsd).toBe(1.5);

    const custom = {
      ...DEFAULT_CONFIG,
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        standard: { model: 'opus', timeoutMinutes: 30, budgetUsd: 3 },
      },
    };
    const profile = resolveProfile('standard', custom);
    expect(profile.model).toBe('opus');
    expect(profile.timeoutMs).toBe(30 * 60 * 1000);
    expect(profile.maxBudgetUsd).toBe(3);
  });

  it('quick: never raises the cap above the configured one', () => {
    const profile = resolveProfile('quick', { ...DEFAULT_CONFIG, maxDiffKb: 32 });
    expect(profile.maxDiffKb).toBe(32);
  });

  it('standard: config model and cap, read tools, no focus, no refutation', () => {
    const profile = resolveProfile('standard', DEFAULT_CONFIG);
    expect(profile.model).toBe('sonnet');
    expect(profile.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(profile.maxDiffKb).toBe(200);
    expect(profile.promptFocus).toBeUndefined();
    expect(profile.refute).toBe(false);
  });

  it('deep: strongest model and the refutation pass', () => {
    const profile = resolveProfile('deep', DEFAULT_CONFIG);
    expect(profile.model).toBe('opus');
    expect(profile.refute).toBe(true);
    expect(profile.promptFocus).toContain('independently');
  });

  it('a custom profile is deep-shaped and carries its own instructions', () => {
    const config = {
      ...DEFAULT_CONFIG,
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        audit: {
          model: 'claude-fable-5',
          timeoutMinutes: 30,
          budgetUsd: 10,
          instructions: 'Hunt for injection and secrets.',
        },
      },
    };
    const profile = resolveProfile('audit', config);

    expect(profile.model).toBe('claude-fable-5');
    expect(profile.tools).toEqual(['Read', 'Grep', 'Glob']); // explores like deep
    expect(profile.refute).toBe(true); // verifies like deep
    expect(profile.maxBudgetUsd).toBe(10);
    expect(profile.promptFocus).toContain('Hunt for injection');
  });

  it('throws on an unknown profile name, listing the available ones', () => {
    expect(() => resolveProfile('nope', DEFAULT_CONFIG)).toThrow(/Unknown profile "nope".*deep/);
  });
});

describe('detectContext', () => {
  it('detects CI from the CI env var', () => {
    expect(detectContext({ CI: 'true' }, true)).toBe('ci');
    expect(detectContext({ CI: '1' }, false)).toBe('ci');
  });

  it('treats CI=false as not CI', () => {
    expect(detectContext({ CI: 'false' }, true)).toBe('manual');
  });

  it('distinguishes manual (TTY) from hook (no TTY)', () => {
    expect(detectContext({}, true)).toBe('manual');
    expect(detectContext({}, false)).toBe('hook');
  });
});
