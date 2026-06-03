import { describe, expect, it } from 'vitest';
import { buildVerifyUserPrompt, VERIFY_SYSTEM_PROMPT } from '@/openai/prompt';
import type { Finding } from '@/openai/schema';
import { decideKeep, type SingleVerdict } from '@/openai/verify';

function v(verdict: SingleVerdict['verdict']): SingleVerdict {
  return { model: 'verifier', verdict, reason: 'reason' };
}

describe('decideKeep (refutation-first consensus)', () => {
  it('keeps a finding with no verdicts so the gate is a no-op', () => {
    expect(decideKeep([])).toBe(true);
  });

  it('keeps a finding a single verifier confirms as real', () => {
    expect(decideKeep([v('real')])).toBe(true);
  });

  it('drops a finding a single verifier refutes as a false positive', () => {
    expect(decideKeep([v('false_positive')])).toBe(false);
  });

  it('keeps a finding when the only verifier errors, failing open', () => {
    expect(decideKeep([v('error')])).toBe(true);
  });

  it('drops a finding only when every verifier refutes it', () => {
    expect(decideKeep([v('false_positive'), v('false_positive')])).toBe(false);
  });

  it('keeps a split panel to preserve recall', () => {
    expect(decideKeep([v('real'), v('false_positive')])).toBe(true);
  });

  it('keeps a finding when an error accompanies a refutation, failing open', () => {
    expect(decideKeep([v('false_positive'), v('error')])).toBe(true);
  });

  it('keeps a finding when every verifier errors', () => {
    expect(decideKeep([v('error'), v('error')])).toBe(true);
  });

  it('keeps a unanimously confirmed finding', () => {
    expect(decideKeep([v('real'), v('real')])).toBe(true);
  });
});

describe('VERIFY_SYSTEM_PROMPT', () => {
  it('is refutation-first and defaults to a false positive without diff confirmation', () => {
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/refutation-first/i);
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/false_positive/);
  });

  it('declares the finding and diff as untrusted input', () => {
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/untrusted/i);
  });
});

describe('buildVerifyUserPrompt', () => {
  const finding: Finding = {
    file: 'src/pay.ts',
    line: 12,
    severity: 'critical',
    category: 'security',
    message: 'Hardcoded secret committed in source.',
    confidence: 0.91,
    suggestion: null,
  };

  it('includes the finding and the file diff under an untrusted-input marker', () => {
    const out = buildVerifyUserPrompt(finding, [
      { filename: 'src/pay.ts', patch: '@@ -0,0 +1 @@\n+const KEY = "x";' },
    ]);
    expect(out).toMatch(/untrusted input/i);
    expect(out).toContain('src/pay.ts:12');
    expect(out).toContain('Hardcoded secret committed in source.');
    expect(out).toContain('const KEY = "x";');
  });
});
