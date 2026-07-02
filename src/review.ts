import { ClaudeEngineError, type ClaudeRunOptions, runClaude } from './engine/claude.js';
import { buildReviewPrompt } from './prompt.js';
import { type ReviewResult, reviewResultJsonSchema, reviewResultSchema } from './schema.js';
import { type ChangeSet, resolveWorkingTreeTarget } from './targets.js';

export type EngineFn = typeof runClaude;

export interface ReviewRunOptions {
  cwd: string;
  /** Injectable for tests; defaults to the real claude CLI adapter. */
  engine?: EngineFn;
}

export type ReviewRunOutcome =
  | { kind: 'empty' }
  | { kind: 'reviewed'; result: ReviewResult; costUsd?: number; durationMs?: number };

// M1 fixed settings; M4 turns these into depth profiles.
const REVIEWER_SETTINGS: Omit<ClaudeRunOptions, 'prompt' | 'appendSystemPrompt' | 'cwd'> = {
  jsonSchema: reviewResultJsonSchema,
  tools: ['Read', 'Grep', 'Glob'],
  model: 'sonnet',
  maxTurns: 40,
  maxBudgetUsd: 1.5,
  timeoutMs: 10 * 60 * 1000,
};

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const changeSet = await resolveWorkingTreeTarget(opts.cwd);
  if (isEmpty(changeSet)) return { kind: 'empty' };

  const engine = opts.engine ?? runClaude;
  const { prompt, appendSystemPrompt } = buildReviewPrompt(changeSet);

  const envelope = await engine({
    prompt,
    appendSystemPrompt,
    cwd: opts.cwd,
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
      cwd: opts.cwd,
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

  return { kind: 'reviewed', result: parsed.data, costUsd, durationMs };
}

function isEmpty(changeSet: ChangeSet): boolean {
  return !changeSet.diff.trim() && changeSet.newFiles.length === 0;
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
