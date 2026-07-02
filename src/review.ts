import { loadConfig } from './config.js';
import { ClaudeEngineError, runClaude } from './engine/claude.js';
import { buildReviewPrompt } from './prompt.js';
import { loadPrinciples, loadRules } from './rules.js';
import {
  type ReviewResult,
  type Severity,
  reviewResultJsonSchema,
  reviewResultSchema,
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
      costUsd?: number;
      durationMs?: number;
    };

// M3 fixed settings; M4 turns these into depth profiles.
const REVIEWER_SETTINGS = {
  jsonSchema: reviewResultJsonSchema,
  tools: ['Read', 'Grep', 'Glob'],
  maxTurns: 40,
  maxBudgetUsd: 1.5,
  timeoutMs: 10 * 60 * 1000,
};

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const repoRoot = await resolveRepoRoot(opts.cwd);
  const config = await loadConfig(repoRoot);
  const target: TargetSpec = opts.target ?? { kind: 'working-tree' };

  const changeSet = await resolveTarget(repoRoot, target, config.ignore);
  if (isEmpty(changeSet)) return { kind: 'empty' };
  enforceSizeCap(changeSet, config.maxDiffKb);

  const engine = opts.engine ?? runClaude;
  const [principles, rules] = await Promise.all([loadPrinciples(), loadRules(repoRoot)]);
  const { prompt, appendSystemPrompt } = buildReviewPrompt({
    changeSet,
    principles,
    rules,
    task: opts.task ?? changeSet.taskFallback,
  });

  const envelope = await engine({
    prompt,
    appendSystemPrompt,
    cwd: repoRoot,
    model: config.models.standard,
    ...REVIEWER_SETTINGS,
  });

  let structured = envelope.structured_output;
  let costUsd = envelope.total_cost_usd ?? 0;
  let durationMs = envelope.duration_ms ?? 0;

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
    durationMs += converted.duration_ms ?? 0;
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

  return {
    kind: 'reviewed',
    result: parsed.data,
    failOn: opts.failOn ?? config.failOn,
    target: changeSet.description,
    costUsd,
    durationMs,
  };
}

function isEmpty(changeSet: ChangeSet): boolean {
  if (changeSet.kind === 'snapshot') return changeSet.files.length === 0;
  return !changeSet.diff.trim() && changeSet.newFiles.length === 0;
}

function enforceSizeCap(changeSet: ChangeSet, maxDiffKb: number): void {
  const bytes =
    Buffer.byteLength(changeSet.diff) +
    changeSet.newFiles.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
  if (bytes > maxDiffKb * 1024) {
    throw new TargetError(
      `The change is ~${Math.round(bytes / 1024)} KB, over the ${maxDiffKb} KB cap. ` +
        'Review a smaller change, add ignore globs, or raise maxDiffKb in .agentlint/config.json.',
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
