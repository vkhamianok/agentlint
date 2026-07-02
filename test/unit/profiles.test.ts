import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config.js';
import { detectContext, resolveProfile } from '../../src/profiles.js';

describe('resolveProfile', () => {
  it('quick: cheap model, tight caps, blocker focus, no refutation', () => {
    const profile = resolveProfile('quick', DEFAULT_CONFIG);
    expect(profile.model).toBe('haiku');
    expect(profile.maxDiffKb).toBe(64); // tighter than the 200 KB config default
    expect(profile.promptFocus).toContain('pre-commit gate');
    expect(profile.refute).toBe(false);
    expect(profile.maxBudgetUsd).toBeLessThan(1);
  });

  it('quick: never raises the cap above the configured one', () => {
    const profile = resolveProfile('quick', { ...DEFAULT_CONFIG, maxDiffKb: 32 });
    expect(profile.maxDiffKb).toBe(32);
  });

  it('standard: config model and cap, no focus, no refutation', () => {
    const profile = resolveProfile('standard', DEFAULT_CONFIG);
    expect(profile.model).toBe('sonnet');
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
