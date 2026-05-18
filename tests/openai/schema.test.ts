import { describe, expect, it } from 'vitest';
import { MAX_FINDINGS_PER_REVIEW, ReviewOutput } from '@/openai/schema';

const validFinding = {
  file: 'src/index.ts',
  line: 42,
  severity: 'warning',
  category: 'bug',
  message: 'Possible null dereference',
  confidence: 0.8,
} as const;

describe('ReviewOutput', () => {
  it('parses a minimal valid review with zero findings', () => {
    const parsed = ReviewOutput.parse({
      summary: 'No issues found in this diff.',
      overall_assessment: 'approve',
      findings: [],
    });
    expect(parsed.findings).toEqual([]);
  });

  it('parses a review with the maximum allowed number of findings', () => {
    const parsed = ReviewOutput.parse({
      summary: 'Five issues to address.',
      overall_assessment: 'request_changes',
      findings: Array.from({ length: MAX_FINDINGS_PER_REVIEW }, (_, i) => ({
        ...validFinding,
        line: i + 1,
      })),
    });
    expect(parsed.findings.length).toBe(MAX_FINDINGS_PER_REVIEW);
  });

  it('rejects a review with more than the maximum allowed findings', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Too many findings.',
        overall_assessment: 'comment',
        findings: Array.from({ length: MAX_FINDINGS_PER_REVIEW + 1 }, (_, i) => ({
          ...validFinding,
          line: i + 1,
        })),
      }),
    ).toThrow();
  });

  it('rejects a finding with an invalid severity', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Bad severity.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, severity: 'minor' }],
      }),
    ).toThrow();
  });

  it('rejects a finding with an invalid category', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Bad category.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, category: 'style' }],
      }),
    ).toThrow();
  });

  it('rejects a finding with a non positive line number', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Bad line.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, line: 0 }],
      }),
    ).toThrow();
  });

  it('rejects a finding with a confidence outside zero to one', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Bad confidence.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, confidence: 1.2 }],
      }),
    ).toThrow();
  });

  it('rejects an unknown overall assessment', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Bad assessment.',
        overall_assessment: 'looks_good',
        findings: [],
      }),
    ).toThrow();
  });

  it('rejects an empty summary string', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: '',
        overall_assessment: 'comment',
        findings: [],
      }),
    ).toThrow();
  });

  it('accepts a finding with confidence at the inclusive boundaries 0 and 1', () => {
    const parsed = ReviewOutput.parse({
      summary: 'Boundary case.',
      overall_assessment: 'comment',
      findings: [
        { ...validFinding, confidence: 0 },
        { ...validFinding, confidence: 1 },
      ],
    });
    expect(parsed.findings.length).toBe(2);
  });

  it('rejects a finding with confidence below zero', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Below boundary.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, confidence: -0.0001 }],
      }),
    ).toThrow();
  });

  it('rejects a finding with line that is not an integer', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Non integer line.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, line: 1.5 }],
      }),
    ).toThrow();
  });

  it('rejects a finding whose file path contains a line break', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'File path with newline.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, file: 'src/foo.ts\n## Critical' }],
      }),
    ).toThrow();
  });

  it('rejects a finding whose file path is the empty string', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Empty file path.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, file: '' }],
      }),
    ).toThrow();
  });

  it('rejects a finding whose message is the empty string', () => {
    expect(() =>
      ReviewOutput.parse({
        summary: 'Empty message.',
        overall_assessment: 'comment',
        findings: [{ ...validFinding, message: '' }],
      }),
    ).toThrow();
  });
});
