import { describe, expect, it } from 'vitest';
import type { Finding } from '@/openai/schema';
import { formatFinding } from '@/webhook/handler';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/index.ts',
    line: 42,
    severity: 'warning',
    category: 'bug',
    message: 'Off-by-one in the loop bound.',
    confidence: 0.8,
    suggestion: null,
    ...over,
  };
}

describe('formatFinding suggestion block', () => {
  it('renders no suggestion block when suggestion is null', () => {
    const out = formatFinding(finding());
    expect(out).not.toContain('suggestion');
    expect(out).toContain('Off-by-one in the loop bound.');
  });

  it('renders a fenced suggestion block with the exact replacement', () => {
    const out = formatFinding(finding({ suggestion: 'for (let i = 0; i < n; i += 1) {' }));
    expect(out).toContain('```suggestion\nfor (let i = 0; i < n; i += 1) {\n```');
  });

  it('preserves the suggestion indentation verbatim', () => {
    const out = formatFinding(finding({ suggestion: '    return total;' }));
    // The line keeps its four leading spaces so the applied change is correct.
    expect(out).toContain('```suggestion\n    return total;\n```');
  });

  it('uses a fence longer than any backtick run inside the suggestion', () => {
    // A suggestion that itself contains a triple-backtick fence must not be able
    // to close our fence early and escape into the comment body.
    const out = formatFinding(finding({ suggestion: 'const md = "```";' }));
    // The inner run is three backticks, so the fence is four and the whole block
    // (open fence, verbatim content, close fence) renders intact.
    expect(out).toContain('````suggestion\nconst md = "```";\n````');
  });

  it('omits the block for a whitespace-only suggestion', () => {
    const out = formatFinding(finding({ suggestion: '   \n  ' }));
    expect(out).not.toContain('suggestion');
  });

  it('omits the block for an over-long suggestion but still posts the finding', () => {
    const out = formatFinding(finding({ suggestion: 'x'.repeat(5000) }));
    expect(out).not.toContain('```suggestion');
    expect(out).toContain('Off-by-one in the loop bound.');
  });

  it('still HTML-escapes the message while leaving the suggestion as code', () => {
    const out = formatFinding(
      finding({ message: 'Use <b> guard', suggestion: 'if (x != null) {' }),
    );
    expect(out).toContain('Use &lt;b&gt; guard');
    expect(out).toContain('```suggestion\nif (x != null) {\n```');
  });
});
