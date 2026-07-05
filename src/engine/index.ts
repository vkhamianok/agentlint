import { execa } from 'execa';

import { claudeBinary, runClaude } from './claude.js';
import { codexBinary, runCodex } from './codex.js';
import { EngineError, type EngineFn } from './types.js';

export { runClaude } from './claude.js';
export { runCodex } from './codex.js';
export type { EngineFn, EngineResult, EngineRunOptions } from './types.js';
export { EngineError } from './types.js';

/** The tiers a profile maps to; each engine names its own model per tier. */
export type ProfileTier = 'quick' | 'standard' | 'deep';

/** One engine's concrete models: three review tiers plus the fixer. */
export interface TierModels {
  quick: string;
  standard: string;
  deep: string;
  /** Model the `--fix` pass uses on this engine. */
  fix: string;
}

export type EngineName = 'claude' | 'openai';

/**
 * An engine: the CLI adapter, the models it offers per tier, and a best-effort
 * test for which model names belong to it (used to route a bare model to its
 * provider without an explicit prefix).
 */
export interface Engine {
  name: EngineName;
  run: EngineFn;
  models: TierModels;
  /** Best-effort: does this model name look like one of this engine's? */
  owns(model: string): boolean;
}

const CLAUDE: Engine = {
  name: 'claude',
  run: runClaude,
  // The historical defaults, now owned by the engine rather than the config.
  models: { quick: 'haiku', standard: 'sonnet', deep: 'opus', fix: 'sonnet' },
  owns: (m) => /^(claude|opus|sonnet|haiku|fable)/i.test(m),
};

const OPENAI: Engine = {
  name: 'openai',
  run: runCodex,
  models: { quick: 'gpt-5.4-mini', standard: 'gpt-5.4', deep: 'gpt-5.5', fix: 'gpt-5.4' },
  owns: (m) => /^(gpt|o\d|codex)/i.test(m),
};

const ALL_ENGINES = [CLAUDE, OPENAI];
/** "codex" is an alias of the openai engine — same CLI, provider-named prefix. */
const BY_NAME: Record<string, Engine> = { claude: CLAUDE, openai: OPENAI, codex: OPENAI };

/** The engine names a user may write (in a prefix, `--engine`, or config). */
export const ENGINE_NAMES = ['claude', 'openai', 'codex'] as const;

/** Looks up an engine by name (or alias), failing loudly on an unknown one. */
export function engineByName(name: string): Engine {
  const engine = BY_NAME[name];
  if (!engine) {
    throw new EngineError(`Unknown engine "${name}". Use "claude" or "openai" (alias "codex").`);
  }
  return engine;
}

/** The one engine whose ownership pattern matches, or undefined if none does. */
function ownerOf(model: string): Engine | undefined {
  return ALL_ENGINES.find((e) => e.owns(model));
}

/** Splits a "provider:model" string; a bare name has no prefix. */
function splitModel(model: string): { prefix?: Engine; bare: string } {
  const colon = model.indexOf(':');
  if (colon === -1) return { bare: model }; // "opus", "claude-opus-4-8"
  const provider = model.slice(0, colon);
  // Only treat a leading token as a provider if it names a known engine; an
  // unknown one is a typo worth surfacing, not a model id that happens to
  // contain a colon.
  if (!BY_NAME[provider]) {
    throw new EngineError(
      `Unknown model provider "${provider}". Use "claude:…" or "openai:…", or a bare model.`,
    );
  }
  return { prefix: engineByName(provider), bare: model.slice(colon + 1) };
}

/** Probes whether an engine's CLI is installed and runnable. */
export type EngineDetector = (engine: Engine) => Promise<boolean>;

const realDetect: EngineDetector = async (engine) => {
  const bin = engine.name === 'claude' ? claudeBinary() : codexBinary();
  try {
    const result = await execa(bin, ['--version'], { reject: false, timeout: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

// The real probe spawns two CLIs; cache it so a run resolves the installed set
// once. Only the real detector is cached — an injected one (tests) is not.
let installedCache: Engine[] | undefined;

/** The engines whose CLI is installed, left-to-right in preference order. */
export async function installedEngines(detect: EngineDetector = realDetect): Promise<Engine[]> {
  if (detect === realDetect && installedCache) return installedCache;
  const flags = await Promise.all(ALL_ENGINES.map((e) => detect(e)));
  const installed = ALL_ENGINES.filter((_, i) => flags[i]);
  if (detect === realDetect) installedCache = installed;
  return installed;
}

/**
 * Picks the default engine when nothing names one: the single installed engine,
 * or claude when both are present. With neither installed, falls back to claude
 * so its adapter can raise the actionable "is claude installed?" error.
 */
async function autodetectEngine(detect: EngineDetector | undefined): Promise<Engine> {
  const installed = await installedEngines(detect ?? realDetect);
  if (installed.length === 0) return CLAUDE;
  return installed.find((e) => e.name === 'claude') ?? installed[0]!;
}

export interface ResolveRunInput {
  /** The profile's model, possibly "provider:model"; undefined = tier default. */
  model?: string;
  /** Highest-priority engine choice (`--engine`); overrides the model's provider. */
  cliEngine?: string;
  /** Lower-priority engine hint (profile.engine / config.engine / env). */
  weakEngine?: string;
  /** Which tier's model to use when no explicit model is given. */
  tier: ProfileTier;
  /** Injectable installed-engine probe (tests). */
  detect?: EngineDetector;
}

export interface RunResolution {
  engine: Engine;
  /** The concrete model to pass the CLI (never a "provider:" prefix). */
  model: string;
}

/**
 * Resolves a review run's engine and model. Precedence for the engine:
 *   `--engine` › the model's "provider:" prefix › the model's ownership ›
 *   profile/config/env hint › autodetect (one installed, else claude).
 * The model is the one explicitly given, unless a higher-priority engine choice
 * disagrees with the model's own provider — then it is that engine's tier model,
 * so `--engine openai` on a claude-modelled profile runs codex's tier default
 * rather than handing a claude model to codex.
 */
export async function resolveRun(input: ResolveRunInput): Promise<RunResolution> {
  const split = input.model !== undefined ? splitModel(input.model) : undefined;
  const bare = split?.bare;
  const modelProvider = split?.prefix ?? (bare !== undefined ? ownerOf(bare) : undefined);

  let engine: Engine;
  if (input.cliEngine) engine = engineByName(input.cliEngine);
  else if (modelProvider) engine = modelProvider;
  else if (input.weakEngine) engine = engineByName(input.weakEngine);
  else engine = await autodetectEngine(input.detect);

  let model: string;
  if (bare === undefined) {
    model = engine.models[input.tier];
  } else if (modelProvider && modelProvider !== engine) {
    // The chosen engine differs from the model's provider — an override wins,
    // and the model can't cross engines, so use the engine's tier model.
    model = engine.models[input.tier];
  } else {
    model = bare;
  }
  return { engine, model };
}
