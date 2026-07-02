import { loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import { type Depth, type DepthProfile, type RunContext, resolveProfile } from './profiles.js';
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
  /** CLI override for the depth profile. */
  depth?: Depth;
  /** Where the run happens; picks the default depth from config. */
  context?: RunContext;
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
      depth: Depth;
      /** Findings dropped by the deep profile's refutation pass. */
      refutedCount: number;
      costUsd: number;
      durationMs: number;
    };

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const startedAt = Date.now();
  const repoRoot = await resolveRepoRoot(opts.cwd);
  const config = await loadConfig(repoRoot);
  const depth = opts.depth ?? config.depth[opts.context ?? 'manual'];
  const profile = resolveProfile(depth, config);
  const target: TargetSpec = opts.target ?? { kind: 'working-tree' };

  const changeSet = await resolveTarget(repoRoot, target, config.ignore);
  if (isEmpty(changeSet)) return { kind: 'empty' };
  enforceSizeCap(changeSet, profile);

  const engine = opts.engine ?? runClaude;
  const [principles, rules] = await Promise.all([
    loadPrinciples(),
    loadRules(repoRoot, {
      selectors: config.rules,
      inheritGlobalRules: config.inheritGlobalRules,
    }),
  ]);
  const { prompt, appendSystemPrompt } = buildReviewPrompt({
    changeSet,
    principles,
    rules,
    task: opts.task ?? changeSet.taskFallback,
    focus: profile.promptFocus,
  });

  const envelope = await engine({
    prompt,
    appendSystemPrompt,
    cwd: repoRoot,
    jsonSchema: reviewResultJsonSchema,
    tools: READ_TOOLS,
    model: profile.model,
    maxTurns: profile.maxTurns,
    maxBudgetUsd: profile.maxBudgetUsd,
    timeoutMs: profile.timeoutMs,
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
    result = {
      ...result,
      findings: refutation.kept,
      // The verdict must track the surviving findings, or a fully-refuted
      // review would still block on the original "block".
      verdict: refutation.kept.some((f) => f.severity === 'blocker') ? 'block' : 'pass',
    };
  }

  return {
    kind: 'reviewed',
    result,
    failOn: opts.failOn ?? config.failOn,
    target: changeSet.description,
    depth,
    refutedCount,
    costUsd,
    durationMs: Date.now() - startedAt,
  };
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
  profile: DepthProfile,
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

function enforceSizeCap(changeSet: ChangeSet, profile: DepthProfile): void {
  const bytes =
    Buffer.byteLength(changeSet.diff) +
    changeSet.newFiles.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
  if (bytes > profile.maxDiffKb * 1024) {
    const hint =
      profile.depth === 'quick'
        ? 'Run with --depth standard for large changes, or review a smaller change.'
        : 'Review a smaller change, add ignore globs, or raise maxDiffKb in .agentlint/config.json.';
    throw new TargetError(
      `The change is ~${Math.round(bytes / 1024)} KB, over the ${profile.maxDiffKb} KB cap of the ${profile.depth} profile. ${hint}`,
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
