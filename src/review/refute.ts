import type { ResolvedProfile } from '../profiles.js';
import { type Finding, refutationJsonSchema, refutationSchema, severityRank } from '../schema.js';
import { buildRefutePrompt } from './prompt.js';
import type { EngineFn } from './run.js';
import type { ChangeSet } from './targets.js';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Caps the refutation pass: total spend and concurrent claude processes must
 * not scale unboundedly with finding count. Blockers are verified first (they
 * gate the commit); findings past the cap are kept un-refuted, matching the
 * "never drop a finding on failure" rule.
 */
const MAX_REFUTATIONS = 8;

/**
 * The verification pass deep and custom profiles run: an independent skeptic
 * per finding tries to refute it. A refuted finding is dropped; a failed or
 * unparseable refutation keeps the finding and never sinks the whole review.
 */
export async function refuteFindings(
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
