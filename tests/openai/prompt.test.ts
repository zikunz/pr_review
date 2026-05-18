import { describe, expect, it } from 'vitest';
import { buildDiffMarkdown, buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';

describe('SYSTEM_PROMPT', () => {
  it('asks for at most five findings, ordered by impact', () => {
    expect(SYSTEM_PROMPT).toMatch(/at most five findings/i);
  });

  it('instructs the model to reference lines that exist in the diff', () => {
    expect(SYSTEM_PROMPT).toMatch(/line.*exists in the diff/i);
  });

  it('lists the focus categories the schema accepts', () => {
    expect(SYSTEM_PROMPT).toMatch(/Bugs/);
    expect(SYSTEM_PROMPT).toMatch(/Security/);
    expect(SYSTEM_PROMPT).toMatch(/Performance/);
    expect(SYSTEM_PROMPT).toMatch(/Concurrency/i);
  });
});

describe('buildDiffMarkdown', () => {
  it('returns an empty string when no files have a patch', () => {
    expect(buildDiffMarkdown([])).toBe('');
    expect(buildDiffMarkdown([{ filename: 'binary.png' }])).toBe('');
  });

  it('wraps each patch in a fenced diff block with the filename', () => {
    const md = buildDiffMarkdown([{ filename: 'src/a.ts', patch: '@@ -1 +1,2 @@\n keep\n+new' }]);
    expect(md).toBe('### src/a.ts\n```diff\n@@ -1 +1,2 @@\n keep\n+new\n```');
  });

  it('separates multiple files with a blank line', () => {
    const md = buildDiffMarkdown([
      { filename: 'a.ts', patch: '@@ -1 +1,2 @@\n keep\n+new' },
      { filename: 'b.ts', patch: '@@ -1 +1,2 @@\n keep\n+new' },
    ]);
    expect(md.split('\n\n').length).toBe(2);
    expect(md).toContain('### a.ts');
    expect(md).toContain('### b.ts');
  });

  it('skips files without a patch but still renders the rest', () => {
    const md = buildDiffMarkdown([
      { filename: 'binary.png' },
      { filename: 'src/a.ts', patch: '@@ -1 +1,2 @@\n keep\n+new' },
    ]);
    expect(md).toContain('### src/a.ts');
    expect(md).not.toContain('binary.png');
  });
});

describe('buildUserPrompt', () => {
  it('places the title, description, and diff in the expected sections', () => {
    const prompt = buildUserPrompt({
      prTitle: 'Add idempotency store',
      prBody: 'Closes #1.',
      files: [{ filename: 'src/lib/idempotency.ts', patch: '@@ -1 +1,3 @@\n+a\n+b' }],
    });
    expect(prompt).toContain('Title: Add idempotency store');
    expect(prompt).toContain('Closes #1.');
    expect(prompt).toContain('# Diff');
    expect(prompt).toContain('### src/lib/idempotency.ts');
  });

  it('substitutes a placeholder when the PR body is null', () => {
    const prompt = buildUserPrompt({
      prTitle: 'No body',
      prBody: null,
      files: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }],
    });
    expect(prompt).toContain('(no description)');
  });

  it('substitutes a placeholder when the PR body is empty whitespace', () => {
    const prompt = buildUserPrompt({
      prTitle: 'Whitespace body',
      prBody: '   \n  ',
      files: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }],
    });
    expect(prompt).toContain('(no description)');
  });

  it('substitutes a placeholder when no textual diff is available', () => {
    const prompt = buildUserPrompt({
      prTitle: 'Binary only PR',
      prBody: 'Replaces logo.png.',
      files: [{ filename: 'logo.png' }],
    });
    expect(prompt).toContain('(no textual diff available)');
  });
});
