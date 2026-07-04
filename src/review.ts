import { cacheDir, cacheKey, readCachedPass, writeCachedPass } from './cache.js';
import { type AgentlintConfig, ConfigError, loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import {
  type ProfileName,
  type ResolvedProfile,
  type RunContext,
  resolveProfile,
} from './profiles.js';
import { buildRefutePrompt, buildReviewPrompt } from './prompt.js';
import { loadPrinciples, loadRules } from './rules.js';
import {
  type Finding,
  type ReviewResult,
  type Severity,
  refutationJsonSchema,
  refutationSchema,
  reviewResultJsonSchema,
  reviewResultSchema,
  severityRank,
} from './schema.js';
import {
  type ChangeSet,
  TargetError,
  type TargetSpec,
  resolveRepoRoot,
  resolveTarget,
} from './targets.js';

export type EngineFn = typeof runClaude;

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
      /** True when the verdict came from the pass cache, not a live run. */
      cached: boolean;
      costUsd: number;
      durationMs: number;
    };

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const startedAt = Date.now();
  const repoRoot = await resolveRepoRoot(opts.cwd);
  const config = await loadConfig(repoRoot);
  const profileName = resolveProfileName(opts, config);
  const profile = resolveProfile(profileName, config);
  opts.onStart?.({ profile: profileName, model: profile.model });
  const target: TargetSpec = opts.target ?? { kind: 'working-tree' };

  const scopeGlobs = resolveScope(opts.scope, config);
  const changeSet = await resolveTarget(repoRoot, target, config.ignore, scopeGlobs);
  if (opts.scope) changeSet.description = `${changeSet.description} — scope "${opts.scope}"`;
  if (isEmpty(changeSet)) return { kind: 'empty' };
  enforceSizeCap(changeSet, profile);

  const engine = opts.engine ?? runClaude;
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
    ]),
  });
  const cachePath = cacheable ? await cacheDir(repoRoot) : undefined;
  if (cachePath) {
    const cachedResult = await readCachedPass(cachePath, key);
    if (cachedResult) {
      return {
        kind: 'reviewed',
        result: cachedResult,
        failOn: opts.failOn ?? config.failOn,
        target: changeSet.description,
        profile: profileName,
        refutedCount: 0,
        cached: true,
        costUsd: 0,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const envelope = await engine({
    prompt,
    appendSystemPrompt,
    cwd: repoRoot,
    jsonSchema: reviewResultJsonSchema,
    tools: profile.tools,
    model: profile.model,
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
      jsonSchema: reviewResultJsonSchema,
      tools: [],
      model: 'haiku',
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
  const parsed = reviewResultSchema.safeParse(structured);
  if (!parsed.success) {
    throw new ClaudeEngineError(
      'Reviewer output did not match the findings schema',
      parsed.error.message,
    );
  }

  let result = parsed.data;
  let refutedCount = 0;
  if (profile.refute && result.findings.length > 0) {
    const refutation = await refuteFindings(engine, repoRoot, profile, changeSet, result.findings);
    refutedCount = result.findings.length - refutation.kept.length;
    costUsd += refutation.costUsd;

    // Downgrade block→pass only when the block rested on blocker findings and
    // none survived refutation. An explicit block on non-blocker grounds, or a
    // surviving blocker, stands — so the refutation pass (deep, custom) is
    // never more lenient than the raw verdict for reasons it did not touch.
    const hadBlocker = result.findings.some((f) => f.severity === 'blocker');
    const keepsBlocker = refutation.kept.some((f) => f.severity === 'blocker');
    result = {
      ...result,
      findings: refutation.kept,
      verdict: result.verdict === 'block' && hadBlocker && !keepsBlocker ? 'pass' : result.verdict,
    };
  }

  if (cachePath && result.verdict === 'pass') {
    // Caching is an optimization, never part of the verdict: a failed write
    // (read-only worktree, disk full) is reported but must not turn an
    // already-computed pass into a crash.
    try {
      await writeCachedPass(cachePath, key, result);
    } catch (err) {
      console.error(
        `agentlint: could not write the verdict cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    kind: 'reviewed',
    result,
    failOn: opts.failOn ?? config.failOn,
    target: changeSet.description,
    profile: profileName,
    refutedCount,
    cached: false,
    costUsd,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The profile to run: an explicit --profile, else the one configured for the
 * run context. Either source may name a profile that does not exist (a typo,
 * a stale defaultProfile entry) — that must fail loudly, not fall through.
 */
/**
 * Turns a --scope name into its include globs, or undefined when no scope was
 * asked for. An unknown name is a user error (a typo, a stale scope) — fail
 * loudly rather than silently reviewing the whole repo.
 */
function resolveScope(name: string | undefined, config: AgentlintConfig): string[] | undefined {
  if (!name) return undefined;
  const globs = config.scopes[name];
  if (!globs) {
    const defined = Object.keys(config.scopes).sort().join(', ') || '(none defined)';
    throw new ConfigError(
      `Unknown scope "${name}". Defined scopes: ${defined}. Add one under "scopes" in .agentlint/config.json.`,
    );
  }
  return globs;
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

/**
 * Caps the refutation pass: total spend and concurrent claude processes must
 * not scale unboundedly with finding count. Blockers are verified first (they
 * gate the commit); findings past the cap are kept un-refuted, matching the
 * "never drop a finding on failure" rule.
 */
const MAX_REFUTATIONS = 8;

async function refuteFindings(
  engine: EngineFn,
  repoRoot: string,
  profile: ResolvedProfile,
  changeSet: ChangeSet,
  findings: Finding[],
): Promise<{ kept: Finding[]; costUsd: number }> {
  const byPriority = [...findings.keys()].sort(
    (a, b) => severityRank(findings[b]!.severity) - severityRank(findings[a]!.severity),
  );
  const toRefute = new Set(byPriority.slice(0, MAX_REFUTATIONS));

  const verdicts = await Promise.all(
    findings.map(async (finding, index) => {
      if (!toRefute.has(index)) return { refuted: false, costUsd: 0 };
      // A failed or unparseable refutation must never drop a finding, and
      // must never sink the whole (already paid for) review.
      try {
        const envelope = await engine({
          prompt: buildRefutePrompt(JSON.stringify(finding, null, 2), changeSet),
          cwd: repoRoot,
          jsonSchema: refutationJsonSchema,
          tools: READ_TOOLS,
          model: profile.model,
          maxTurns: 15,
          maxBudgetUsd: 0.5,
          timeoutMs: 5 * 60 * 1000,
        });
        const parsed = refutationSchema.safeParse(envelope.structured_output);
        return {
          refuted: parsed.success ? parsed.data.refuted : false,
          costUsd: envelope.total_cost_usd ?? 0,
        };
      } catch {
        return { refuted: false, costUsd: 0 };
      }
    }),
  );

  return {
    kept: findings.filter((_, i) => !verdicts[i]!.refuted),
    costUsd: verdicts.reduce((sum, v) => sum + v.costUsd, 0),
  };
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
