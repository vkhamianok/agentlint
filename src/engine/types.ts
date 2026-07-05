/**
 * The engine interface every provider adapter implements. An engine takes a
 * prompt (plus a JSON schema, tools, model, and caps) and returns the model's
 * answer — ideally as validated structured output. Claude and codex are the
 * two adapters; see engine/index.ts for how a "provider:model" string picks one.
 */
export interface EngineRunOptions {
  prompt: string;
  /** Principles + rules + output contract; folded into the prompt if the CLI has no system channel. */
  appendSystemPrompt?: string;
  /** JSON Schema the answer must conform to; the validated object lands in structured_output. */
  jsonSchema?: object;
  /** Read-only exploration tools to expose. Empty array = single-shot, no tools. */
  tools?: string[];
  /** "acceptEdits" for the fixer; reviews never set this (they must not edit). */
  permissionMode?: string;
  /** The bare model name for the chosen provider (no "provider:" prefix). */
  model?: string;
  /** Hard spend cap per run. Honored by claude; codex has no equivalent. */
  maxBudgetUsd?: number;
  /** Hard turn cap per run. Honored by claude; codex manages its own loop. */
  maxTurns?: number;
  cwd?: string;
  timeoutMs?: number;
  /** Live per-tool step callback; only the claude adapter streams these today. */
  onStep?: (step: string) => void;
}

/** What every engine returns: the answer text and, when a schema was given, the parsed object. */
export interface EngineResult {
  result: string;
  structured_output?: unknown;
  /** USD cost of the run when the provider reports it (claude does, codex does not). */
  total_cost_usd?: number;
}

export type EngineFn = (opts: EngineRunOptions) => Promise<EngineResult>;

export class EngineError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
