import { type AgentlintConfig, ConfigError } from './config.js';
import type { RuleSelector } from './rules.js';

export const BUILTIN_PROFILES = ['quick', 'standard', 'deep'] as const;
/** A profile is any name present in config.profiles — the built-ins plus custom ones. */
export type ProfileName = string;

/** Where the run happens; decides the default profile via config.defaultProfile. */
export type RunContext = 'manual' | 'hook' | 'ci';

export interface ResolvedProfile {
  name: ProfileName;
  model: string;
  /** Built-in tools for the reviewer; empty = single-shot, diff only. */
  tools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** Effective size cap; quick tightens the config value. */
  maxDiffKb: number;
  /** Extra prompt instruction narrowing the review. */
  promptFocus?: string;
  /** Run the per-finding refutation pass. */
  refute: boolean;
  /** Rule selectors this profile adds (or, standing alone, uses). */
  rules?: RuleSelector[];
  /** When false, drop config.rules and the project rules dir for this profile. */
  inheritProjectRules: boolean;
  /** A scope name this profile restricts to unless --scope overrides it. */
  defaultScope?: string;
}

const QUICK_MAX_DIFF_KB = 64;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];

const QUICK_FOCUS = `This is a fast pre-commit gate, not a full review. Focus exclusively on
blockers: broken correctness and dishonesty (swallowed errors, deleted or
weakened tests, faked results). Skip style, simplicity, and convention
commentary entirely. When in doubt whether something is a blocker, it is not.`;

const DEEP_FOCUS = `This is a thorough review. Read the surrounding code, callers, and tests
before judging. Every finding you report will be independently verified,
so report everything real — but nothing you cannot defend.`;

/**
 * Turns a profile name into concrete run settings. Behaviour is fixed by the
 * built-in shapes: quick is a single-shot diff gate; standard explores;
 * deep and any custom profile explore AND run the refutation pass — a custom
 * profile is meant to be a thorough, deliberate audit. Its config carries the
 * model, budget, timeout, and free-text focus; the built-ins add their own.
 */
export function resolveProfile(name: ProfileName, config: AgentlintConfig): ResolvedProfile {
  const settings = config.profiles[name];
  if (!settings) {
    throw new ConfigError(
      `Unknown profile "${name}". Available: ${Object.keys(config.profiles).sort().join(', ')}.`,
    );
  }

  const isQuick = name === 'quick';
  const explore = !isQuick;
  // Standard is the only exploring profile that skips refutation; deep and
  // custom profiles verify their findings.
  const refute = explore && name !== 'standard';

  // The "be thorough, findings will be verified" framing applies wherever
  // the refutation pass runs — deep and custom profiles alike. A custom
  // profile's own instructions layer on top of it.
  const builtinFocus = isQuick ? QUICK_FOCUS : refute ? DEEP_FOCUS : undefined;
  const promptFocus =
    [builtinFocus, settings.instructions].filter(Boolean).join('\n\n') || undefined;

  return {
    name,
    model: settings.model,
    tools: explore ? READ_TOOLS : [],
    maxTurns: isQuick ? 4 : refute ? 60 : 40,
    maxBudgetUsd: settings.budgetUsd,
    timeoutMs: settings.timeoutMinutes * 60 * 1000,
    maxDiffKb: isQuick ? Math.min(config.maxDiffKb, QUICK_MAX_DIFF_KB) : config.maxDiffKb,
    promptFocus,
    refute,
    rules: settings.rules,
    inheritProjectRules: settings.inheritProjectRules ?? true,
    defaultScope: settings.defaultScope,
  };
}

/** CI beats hook beats manual: CI sets CI=..., hooks have no TTY. */
export function detectContext(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): RunContext {
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return 'ci';
  return isTTY ? 'manual' : 'hook';
}
