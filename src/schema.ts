import { createHash } from 'node:crypto';

import { z } from 'zod';

export const severities = ['info', 'warning', 'blocker'] as const;
export type Severity = (typeof severities)[number];

// looseObject: extra keys from the model must not fail a whole review —
// the CLI aborts with error_max_structured_output_retries after repeated
// validation misses, so the generated JSON Schema must be forgiving.
export const findingSchema = z.looseObject({
  file: z.string().describe('Repo-relative path of the file the finding is in'),
  line: z
    .number()
    .int()
    .nullable()
    .describe('1-based line in the new version of the file, or null for file-level findings'),
  severity: z.enum(severities),
  title: z.string().describe('One short sentence naming the defect'),
  what: z.string().describe('What is wrong, concretely'),
  why: z.string().describe('Why it matters: consequence or failure scenario'),
  // No upper bound: like looseObject above, a hard cap would turn "one fix
  // too many" into a fatal structured-output retry loop. The prompt still
  // asks for one or two.
  fixes: z
    .array(z.string())
    .min(1)
    .describe('One or two candidate ways to fix it, concrete enough to act on'),
  confidence: z.enum(['high', 'medium', 'low']),
});

// What the reviewer authors. It does NOT carry a verdict: pass/block is a
// derived gate outcome (the findings' severity vs failOn), not something the
// model decides. See docs/design-verdict-and-resolution.md.
export const reviewerOutputSchema = z.looseObject({
  summary: z.string().describe('One paragraph: overall judgment of the change'),
  findings: z.array(findingSchema),
  questions: z
    .array(z.string())
    .describe('Genuine forks the reviewer could not decide alone; empty if none'),
});

// What an actor (human or agent) decided about a finding or a whole run. The
// same shape at both levels: open by default, or ignored with a reason and an
// audit trail. See docs/design-verdict-and-resolution.md.
export const resolutionSchema = z.looseObject({
  state: z.enum(['open', 'ignored']),
  reason: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
});

// A stored finding: the reviewer's finding plus a stable id (so an ignore can
// point at it) and its resolution. The id and resolution are added by us, not
// authored by the model.
export const resolvedFindingSchema = z.looseObject({
  ...findingSchema.shape,
  id: z.string(),
  resolution: resolutionSchema,
});

// The stored and rendered result: the reviewer's output plus the verdict we
// derive from it, the resolved findings, and an optional whole-run resolution.
// Cache entries and reports use this shape.
export const reviewResultSchema = z.looseObject({
  verdict: z.enum(['pass', 'block']),
  summary: z.string(),
  findings: z.array(resolvedFindingSchema),
  questions: z.array(z.string()),
  resolution: resolutionSchema.optional(),
});

export type Finding = z.infer<typeof findingSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ResolvedFinding = z.infer<typeof resolvedFindingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** A stable short id for a finding, derived from its content (like a short sha). */
export function findingId(f: Finding): string {
  return createHash('sha256')
    .update(JSON.stringify([f.file, f.line, f.severity, f.title, f.what]))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Converts a zod schema into JSON Schema for the claude CLI's --json-schema.
 *
 * The top-level `$schema` key zod emits must be stripped: Claude Code 2.1.198
 * silently fails to expose the StructuredOutput tool when it is present, and
 * the model falls back to prose answers.
 */
export function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const reviewerOutputJsonSchema = toCliJsonSchema(reviewerOutputSchema);

/** Verdict of one refutation call in a profile's verification pass (deep or custom). */
export const refutationSchema = z.looseObject({
  refuted: z.boolean().describe('true if the finding is wrong, exaggerated, or unverifiable'),
  reason: z.string().describe('one or two sentences justifying the verdict'),
});

export type Refutation = z.infer<typeof refutationSchema>;

export const refutationJsonSchema = toCliJsonSchema(refutationSchema);

export function severityRank(s: Severity): number {
  return severities.indexOf(s);
}

/**
 * The gate outcome, derived from the findings — never authored by the reviewer.
 * An ignored run passes outright; otherwise it blocks when any OPEN finding
 * reaches the failOn threshold. Findings without a resolution count as open, so
 * this works for both reviewer findings and resolved ones.
 */
export function deriveVerdict(
  findings: Array<{ severity: Severity; resolution?: Resolution }>,
  failOn: Severity,
  runResolution?: Resolution,
): 'pass' | 'block' {
  if (runResolution?.state === 'ignored') return 'pass';
  const threshold = severityRank(failOn);
  return findings.some(
    (f) => f.resolution?.state !== 'ignored' && severityRank(f.severity) >= threshold,
  )
    ? 'block'
    : 'pass';
}
