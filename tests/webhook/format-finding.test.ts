import { describe, expect, it } from 'vitest';
import type { Finding, WalkthroughItem } from '@/openai/schema';
import { formatFinding, formatWalkthroughSection } from '@/webhook/handler';

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

describe('formatWalkthroughSection', () => {
  function wt(over: Partial<WalkthroughItem>[]): WalkthroughItem[] {
    return over.map((o) => ({ area: 'src/x.ts', change: 'does a thing', ...o }));
  }

  it('returns an empty string for no items', () => {
    expect(formatWalkthroughSection([])).toBe('');
  });

  it('renders a Markdown table with a header and a row per item', () => {
    const out = formatWalkthroughSection(wt([{ area: 'src/a.ts', change: 'adds a guard' }]));
    expect(out).toContain('**Walkthrough**');
    expect(out).toContain('| Area | Change |');
    expect(out).toContain('| src/a.ts | adds a guard |');
  });

  it('escapes the column separator so a cell cannot add a column', () => {
    const out = formatWalkthroughSection(wt([{ area: 'a|b', change: 'x | y' }]));
    expect(out).toContain('| a\\|b | x \\| y |');
  });

  it('collapses newlines so a cell cannot break the row', () => {
    const out = formatWalkthroughSection(wt([{ change: 'line one\nline two' }]));
    expect(out).toContain('line one line two');
    expect(out).not.toContain('line one\nline two');
  });

  it('HTML-escapes and neutralizes link brackets in cells', () => {
    const out = formatWalkthroughSection(wt([{ change: 'see <b> and [click](evil)' }]));
    expect(out).toContain('see &lt;b&gt; and \\[click\\](evil)');
  });
});
