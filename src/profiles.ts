import type { AgentlintConfig } from './config.js';

export const depths = ['quick', 'standard', 'deep'] as const;
export type Depth = (typeof depths)[number];

/** Where the run happens; decides the default depth via config.depth. */
export type RunContext = 'manual' | 'hook' | 'ci';

export interface DepthProfile {
  depth: Depth;
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
}

const QUICK_MAX_DIFF_KB = 64;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];

const QUICK_FOCUS = `This is a fast pre-commit gate, not a full review. Focus exclusively on
blockers: broken correctness and dishonesty (swallowed errors, deleted or
weakened tests, faked results). Skip style, simplicity, and convention
commentary entirely. When in doubt whether something is a blocker, it is not.`;

const DEEP_FOCUS = `This is a deep review: be thorough. Read the surrounding code, callers,
and tests before judging. Every finding you report will be independently
verified, so report everything real — but nothing you cannot defend.`;

export function resolveProfile(depth: Depth, config: AgentlintConfig): DepthProfile {
  switch (depth) {
    case 'quick':
      // No tools: every tool turn is a full API round trip, and a budget of
      // them makes hook latency unpredictable. Quick reads the diff once and
      // answers — measured at roughly half the time of the exploring variant.
      return {
        depth,
        model: config.models.quick,
        tools: [],
        maxTurns: 4,
        maxBudgetUsd: 0.3,
        timeoutMs: config.timeoutMinutes.quick * 60 * 1000,
        maxDiffKb: Math.min(config.maxDiffKb, QUICK_MAX_DIFF_KB),
        promptFocus: QUICK_FOCUS,
        refute: false,
      };
    case 'standard':
      return {
        depth,
        model: config.models.standard,
        tools: READ_TOOLS,
        maxTurns: 40,
        maxBudgetUsd: 1.5,
        timeoutMs: config.timeoutMinutes.standard * 60 * 1000,
        maxDiffKb: config.maxDiffKb,
        refute: false,
      };
    case 'deep':
      return {
        depth,
        model: config.models.deep,
        tools: READ_TOOLS,
        maxTurns: 60,
        maxBudgetUsd: 4,
        timeoutMs: config.timeoutMinutes.deep * 60 * 1000,
        maxDiffKb: config.maxDiffKb,
        promptFocus: DEEP_FOCUS,
        refute: true,
      };
  }
}

/** CI beats hook beats manual: CI sets CI=..., hooks have no TTY. */
export function detectContext(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): RunContext {
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return 'ci';
  return isTTY ? 'manual' : 'hook';
}
