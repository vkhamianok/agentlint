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

// The stored and rendered result: the reviewer's output plus the verdict we
// derive from it. Cache entries and reports use this shape.
export const reviewResultSchema = z.looseObject({
  verdict: z.enum(['pass', 'block']),
  summary: z.string(),
  findings: z.array(findingSchema),
  questions: z.array(z.string()),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

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
 * Block when any finding reaches the failOn threshold; pass otherwise. (Ignored
 * findings will drop out here once resolutions exist; see the design note.)
 */
export function deriveVerdict(findings: Finding[], failOn: Severity): 'pass' | 'block' {
  const threshold = severityRank(failOn);
  return findings.some((f) => severityRank(f.severity) >= threshold) ? 'block' : 'pass';
}
