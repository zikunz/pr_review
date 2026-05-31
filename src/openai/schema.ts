import { z } from 'zod';

export const Severity = z.enum(['critical', 'warning', 'info']);
export type Severity = z.infer<typeof Severity>;

export const Category = z.enum([
  'bug',
  'security',
  'perf',
  'api_misuse',
  'concurrency',
  'question',
]);
export type Category = z.infer<typeof Category>;

export const Finding = z.object({
  // Reject control characters in the path so a crafted finding cannot inject
  // markdown or break out of code spans when the finding is posted as a PR
  // review comment.
  file: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/, { message: 'file must not contain line breaks' }),
  line: z.number().int().positive(),
  severity: Severity,
  category: Category,
  message: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

export const OverallAssessment = z.enum(['comment', 'request_changes', 'approve']);
export type OverallAssessment = z.infer<typeof OverallAssessment>;

// Output schema for the v0.3 verification gate. A second model audits each
// finding the base review produced and returns whether the diff confirms it is
// a real, worth-posting issue or a false positive. The gate keeps a finding
// only when every verifier returns `real`.
export const Verdict = z.object({
  verdict: z.enum(['real', 'false_positive']),
  reason: z.string().min(1),
});
export type Verdict = z.infer<typeof Verdict>;

export const MAX_FINDINGS_PER_REVIEW = 5;

export const ReviewOutput = z.object({
  summary: z.string().min(1),
  overall_assessment: OverallAssessment,
  findings: z.array(Finding).max(MAX_FINDINGS_PER_REVIEW),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
