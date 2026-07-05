import { type AgentlintConfig, ConfigError, SCOPE_NAME_PATTERN, loadConfig } from '../config.js';
import { EngineError, resolveEngine } from '../engine/index.js';
import type { EngineFn } from '../engine/index.js';
import {
  type ProfileName,
  type ResolvedProfile,
  type RunContext,
  resolveProfile,
} from '../profiles.js';
import { loadPrinciples, loadRules } from '../rules.js';
import {
  type Finding,
  type ResolvedFinding,
  type ReviewResult,
  type Severity,
  deriveVerdict,
  findingId,
  reviewerOutputJsonSchema,
  reviewerOutputSchema,
} from '../schema.js';
import { type CacheMeta, cacheDir, cacheKey, readCache, writeCache } from './cache.js';
import { buildReviewPrompt } from './prompt.js';
import { refuteFindings } from './refute.js';
import {
  type ChangeSet,
  TargetError,
  type TargetSpec,
  resolveRepoRoot,
  resolveTarget,
} from './targets.js';

export type { EngineFn };

export interface ReviewRunOptions {
  cwd: string;
  /** What to review; defaults to the uncommitted working tree. */
  target?: TargetSpec;
  /** What the change was supposed to do (--task / --task-file). */
  task?: string;
  /** CLI override for the blocking threshold. */
  failOn?: Severity;
  /** CLI override for the profile; must name a configured profile. */
  profile?: ProfileName;
  /** Restrict the review to a named scope's paths (--scope). */
  scope?: string;
  /** Where the run happens; picks the default profile from config. */
  context?: RunContext;
  /** Skip the pass-verdict cache for this run (--no-cache). */
  noCache?: boolean;
  /** Called once the profile resolves, so a caller can enrich its progress. */
  onStart?: (info: { profile: ProfileName; model: string }) => void;
  /** Called per tool the reviewer runs; enables the live streaming path. */
  onStep?: (step: string) => void;
  /** Injectable for tests; defaults to the real claude CLI adapter. */
  engine?: EngineFn;
}

export type ReviewRunOutcome =
  | { kind: 'empty' }
  | {
      kind: 'reviewed';
      result: ReviewResult;
      /** Final blocking threshold: CLI override or config. */
      failOn: Severity;
      target: string;
      profile: ProfileName;
      /** Findings dropped by the refutation pass. */
      refutedCount: number;
      /** True when the verdict came from the cache, not a live run. */
      cached: boolean;
      costUsd: number;
      durationMs: number;
      /** The cache key of this run; the handle `ignore --run` points at. */
      runId: string;
    };

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const startedAt = Date.now();
  const repoRoot = await resolveRepoRoot(opts.cwd);
  const config = await loadConfig(repoRoot);
  const profileName = resolveProfileName(opts, config);
  const profile = resolveProfile(profileName, config);
  // failOn decides pass/block, so it shapes the verdict and belongs in the
  // cache key (below) — a stricter threshold must not reuse a laxer pass.
  const failOn = opts.failOn ?? config.failOn;
  opts.onStart?.({ profile: profileName, model: profile.model });
  const target: TargetSpec = opts.target ?? { kind: 'working-tree' };

  // An explicit --scope wins; otherwise the profile may carry a default scope.
  const scopeName = opts.scope ?? profile.defaultScope;
  const scopeGlobs = resolveScope(scopeName, config);
  const changeSet = await resolveTarget(repoRoot, target, config.ignore, scopeGlobs);
  if (scopeName) changeSet.description = `${changeSet.description} — scope "${scopeName}"`;
  if (isEmpty(changeSet)) return { kind: 'empty' };
  enforceSizeCap(changeSet, profile);

  // Pick the provider from the model string ("openai:…" → codex) and pass it
  // the bare model. A test-injected engine bypasses the registry.
  const chosen = resolveEngine(profile.model);
  const engine = opts.engine ?? chosen.engine;
  const model = chosen.model;
  const [principles, rules] = await Promise.all([
    loadPrinciples(),
    loadRules(repoRoot, {
      selectors: config.rules,
      profileSelectors: profile.rules,
      inheritProjectRules: profile.inheritProjectRules,
      inheritGlobalRules: config.inheritGlobalRules,
    }),
  ]);
  const task = opts.task ?? changeSet.taskFallback;
  const { prompt, appendSystemPrompt } = buildReviewPrompt({
    changeSet,
    principles,
    rules,
    task,
    focus: profile.promptFocus,
    canExplore: profile.tools.length > 0,
  });

  // The key hashes the change AND everything that shapes the verdict: the
  // guidance (principles, rules) and the profile's verdict-shaping settings
  // (model, focus, explore, refute). Each profile therefore caches for
  // itself — there is no cross-profile satisfaction. Snapshot "changes" are
  // only a file listing (identical keys could mean different file contents),
  // so snapshots are never cached.
  const cacheable = !opts.noCache && changeSet.kind !== 'snapshot';
  const key = cacheKey({
    change: JSON.stringify([
      changeSet.kind,
      changeSet.description,
      changeSet.diff,
      changeSet.newFiles,
      task,
    ]),
    guidance: JSON.stringify([
      principles,
      rules,
      profile.model,
      profile.promptFocus ?? '',
      profile.tools.length > 0,
      profile.refute,
      failOn,
    ]),
  });
  const cachePath = cacheable ? await cacheDir(repoRoot) : undefined;
  if (cachePath) {
    const cached = await readCache(cachePath, key);
    if (cached) {
      // Re-derive: an `ignore` may have flipped a finding's resolution since
      // this entry was written, so the stored verdict can be stale.
      const verdict = deriveVerdict(cached.result.findings, failOn, cached.result.resolution);
      return {
        kind: 'reviewed',
        result: { ...cached.result, verdict },
        failOn,
        target: changeSet.description,
        profile: profileName,
        refutedCount: 0,
        cached: true,
        costUsd: 0,
        durationMs: Date.now() - startedAt,
        runId: key,
      };
    }
  }

  const envelope = await engine({
    prompt,
    appendSystemPrompt,
    cwd: repoRoot,
    jsonSchema: reviewerOutputJsonSchema,
    tools: profile.tools,
    model,
    maxTurns: profile.maxTurns,
    maxBudgetUsd: profile.maxBudgetUsd,
    timeoutMs: profile.timeoutMs,
    // Only the main exploring review streams its steps; the salvage and
    // refutation calls stay on the plain path.
    onStep: opts.onStep,
  });

  let structured = envelope.structured_output;
  let costUsd = envelope.total_cost_usd ?? 0;

  // --json-schema is best-effort: the model can still answer in prose
  // (stop_reason end_turn, no structured_output). Salvage the review with a
  // cheap conversion call instead of throwing the whole run away.
  if (structured === undefined && envelope.result.trim()) {
    const converted = await engine({
      prompt:
        'Below is a code review in prose. Call the StructuredOutput tool with ' +
        'its faithful conversion: same findings, same severities, same fixes. ' +
        'Do not add, drop, or soften anything. Do not reply with text.\n\n' +
        envelope.result,
      jsonSchema: reviewerOutputJsonSchema,
      tools: [],
      // Cheap salvage on claude (haiku); on another provider reuse its model.
      model: chosen.provider === 'claude' ? 'haiku' : model,
      maxTurns: 4,
      maxBudgetUsd: 0.2,
      cwd: repoRoot,
      timeoutMs: 2 * 60 * 1000,
    });
    structured = converted.structured_output ?? extractJson(converted.result);
    costUsd += converted.total_cost_usd ?? 0;
  }

  // The schema was enforced CLI-side; this parse is a local guard against
  // contract drift. Failure means a broken engine, not a review verdict —
  // surface it as an engine error (exit 2), never a silent pass.
  const parsed = reviewerOutputSchema.safeParse(structured);
  if (!parsed.success) {
    throw new EngineError(
      'Reviewer output did not match the findings schema',
      parsed.error.message,
    );
  }

  const output = parsed.data;
  let findings: Finding[] = output.findings;
  let refutedCount = 0;
  if (profile.refute && findings.length > 0) {
    const refutation = await refuteFindings(engine, repoRoot, model, changeSet, findings);
    refutedCount = findings.length - refutation.kept.length;
    costUsd += refutation.costUsd;
    findings = refutation.kept;
  }

  // Give each surviving finding a stable id and an open resolution, so an
  // `ignore` has something to point at. The reviewer reports and rates; the
  // gate decides — refutation only removes findings, and the verdict follows.
  const resolved: ResolvedFinding[] = findings.map((f) => ({
    ...f,
    id: findingId(f),
    resolution: { state: 'open' as const },
  }));
  const result: ReviewResult = {
    verdict: deriveVerdict(resolved, failOn),
    summary: output.summary,
    findings: resolved,
    questions: output.questions,
  };

  if (cachePath) {
    // Caching is an optimization, never part of the verdict: a failed write
    // (read-only worktree, disk full) is reported but must not crash a run
    // whose result is already computed.
    const meta: CacheMeta = {
      profile: profileName,
      model: profile.model,
      target: changeSet.description,
      failOn,
      at: new Date().toISOString(),
    };
    try {
      await writeCache(cachePath, key, { result, meta });
    } catch (err) {
      console.error(
        `agentlint: could not write the verdict cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    kind: 'reviewed',
    result,
    failOn,
    target: changeSet.description,
    profile: profileName,
    refutedCount,
    cached: false,
    costUsd,
    durationMs: Date.now() - startedAt,
    runId: key,
  };
}

/**
 * The profile to run: an explicit --profile, else the one configured for the
 * run context. Either source may name a profile that does not exist (a typo,
 * a stale defaultProfile entry) — that must fail loudly, not fall through.
 */
/**
 * Turns a --scope value into its include globs, or undefined when no scope was
 * asked for. A value is a named scope from the config, or — when it is not a
 * valid scope name (a scope name is kebab, so anything with a slash, star, or
 * dot is not one) — an ad-hoc path glob (comma-separate several), so a one-off
 * review needs no config entry. A bare name that is not defined is a user error
 * (a typo, a stale scope), so fail loudly rather than review the whole repo.
 */
function resolveScope(value: string | undefined, config: AgentlintConfig): string[] | undefined {
  if (!value) return undefined;
  const named = config.scopes[value];
  if (named) return named;
  if (!SCOPE_NAME_PATTERN.test(value)) {
    return value
      .split(',')
      .map((glob) => glob.trim())
      .filter(Boolean);
  }
  const defined = Object.keys(config.scopes).sort().join(', ') || '(none defined)';
  throw new ConfigError(
    `Unknown scope "${value}". Defined scopes: ${defined}. Add one under "scopes", or pass a path glob like "src/**".`,
  );
}

function resolveProfileName(opts: ReviewRunOptions, config: AgentlintConfig): ProfileName {
  const context = opts.context ?? 'manual';
  const name = opts.profile ?? config.defaultProfile[context];
  if (!(name in config.profiles)) {
    const source = opts.profile ? '--profile' : `defaultProfile.${context}`;
    throw new ConfigError(
      `${source} names an unknown profile "${name}". Available: ${Object.keys(config.profiles).sort().join(', ')}.`,
    );
  }
  return name;
}

function isEmpty(changeSet: ChangeSet): boolean {
  if (changeSet.kind === 'snapshot') return changeSet.files.length === 0;
  return !changeSet.diff.trim() && changeSet.newFiles.length === 0;
}

function enforceSizeCap(changeSet: ChangeSet, profile: ResolvedProfile): void {
  const bytes =
    Buffer.byteLength(changeSet.diff) +
    changeSet.newFiles.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
  if (bytes > profile.maxDiffKb * 1024) {
    const hint =
      profile.name === 'quick'
        ? 'Run with --profile standard for large changes, or review a smaller change.'
        : 'Review a smaller change, add ignore globs, or raise maxDiffKb in .agentlint/config.json.';
    throw new TargetError(
      `The change is ~${Math.round(bytes / 1024)} KB, over the ${profile.maxDiffKb} KB cap of the ${profile.name} profile. ${hint}`,
    );
  }
}

/** Last-ditch salvage: a bare JSON object in the text answer, fences and all. */
function extractJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}
