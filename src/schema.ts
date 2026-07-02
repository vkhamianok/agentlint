import { z } from 'zod';

export const severities = ['info', 'warning', 'blocker'] as const;
export type Severity = (typeof severities)[number];

export const findingSchema = z.object({
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
  fixes: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe('One or two candidate ways to fix it, concrete enough to act on'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const reviewResultSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  summary: z.string().describe('One paragraph: overall judgment of the change'),
  findings: z.array(findingSchema),
  questions: z
    .array(z.string())
    .describe('Genuine forks the reviewer could not decide alone; empty if none'),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/**
 * JSON Schema handed to the claude CLI via --json-schema.
 *
 * The top-level `$schema` key zod emits must be stripped: Claude Code 2.1.198
 * silently fails to expose the StructuredOutput tool when it is present, and
 * the reviewer falls back to prose answers.
 */
export const reviewResultJsonSchema: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(reviewResultSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

export function severityRank(s: Severity): number {
  return severities.indexOf(s);
}
