import { runClaude } from './claude.js';
import { runCodex } from './codex.js';
import { EngineError, type EngineFn } from './types.js';

export { runClaude } from './claude.js';
export { runCodex } from './codex.js';
export type { EngineFn, EngineResult, EngineRunOptions } from './types.js';
export { EngineError } from './types.js';

const ENGINES: Record<string, EngineFn> = {
  claude: runClaude,
  openai: runCodex,
  codex: runCodex,
};

export interface ResolvedEngine {
  engine: EngineFn;
  /** The bare model name, with any "provider:" prefix stripped. */
  model: string | undefined;
  provider: string;
}

/**
 * Picks the engine from a model string. A "provider:model" prefix selects the
 * provider ("claude:opus", "openai:gpt-5.5-mini"); a bare name defaults to
 * claude ("opus", "haiku-4.5"), so existing configs keep working. A claude
 * model id that happens to contain no colon (claude-opus-4-8) is left whole.
 */
export function resolveEngine(model: string | undefined): ResolvedEngine {
  if (!model) return { engine: runClaude, model, provider: 'claude' };
  const colon = model.indexOf(':');
  if (colon === -1) return { engine: runClaude, model, provider: 'claude' };

  const provider = model.slice(0, colon);
  const engine = ENGINES[provider];
  if (!engine) {
    throw new EngineError(
      `Unknown model provider "${provider}". Use a "provider:model" like "claude:opus" or "openai:gpt-5.5-mini", or a bare model (defaults to claude).`,
    );
  }
  return { engine, model: model.slice(colon + 1), provider };
}
