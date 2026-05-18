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
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: Severity,
  category: Category,
  message: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

export const OverallAssessment = z.enum(['comment', 'request_changes', 'approve']);
export type OverallAssessment = z.infer<typeof OverallAssessment>;

export const MAX_FINDINGS_PER_REVIEW = 5;

export const ReviewOutput = z.object({
  summary: z.string().min(1),
  overall_assessment: OverallAssessment,
  findings: z.array(Finding).max(MAX_FINDINGS_PER_REVIEW),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
