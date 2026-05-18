import { describe, expect, it } from 'vitest';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';

describe('parseDiffLocations', () => {
  it('returns empty when no patches are present', () => {
    const result = parseDiffLocations([{ path: 'binary.png' }]);
    expect(result).toEqual([]);
  });

  it('extracts added lines on the RIGHT side', () => {
    const result = parseDiffLocations([
      {
        path: 'src/foo.ts',
        patch: ['@@ -1,3 +1,4 @@', ' first', ' second', '+inserted', ' third'].join('\n'),
      },
    ]);
    expect(result).toEqual([{ file: 'src/foo.ts', line: 3, side: 'RIGHT' }]);
  });

  it('skips removed lines because they are not in the new file', () => {
    const result = parseDiffLocations([
      {
        path: 'src/foo.ts',
        patch: ['@@ -1,3 +1,2 @@', ' kept', '-removed', ' also kept'].join('\n'),
      },
    ]);
    expect(result).toEqual([]);
  });

  it('handles multiple hunks within one file', () => {
    const result = parseDiffLocations([
      {
        path: 'src/foo.ts',
        patch: [
          '@@ -1,2 +1,3 @@',
          ' first',
          '+added near top',
          ' second',
          '@@ -10,2 +11,3 @@',
          ' tenth',
          '+added near middle',
          ' eleventh',
        ].join('\n'),
      },
    ]);
    expect(result).toEqual([
      { file: 'src/foo.ts', line: 2, side: 'RIGHT' },
      { file: 'src/foo.ts', line: 12, side: 'RIGHT' },
    ]);
  });

  it('handles multiple files', () => {
    const result = parseDiffLocations([
      {
        path: 'a.ts',
        patch: ['@@ -1 +1,2 @@', ' keep', '+new'].join('\n'),
      },
      {
        path: 'b.ts',
        patch: ['@@ -5,1 +5,2 @@', ' keep', '+new'].join('\n'),
      },
    ]);
    expect(result).toEqual([
      { file: 'a.ts', line: 2, side: 'RIGHT' },
      { file: 'b.ts', line: 6, side: 'RIGHT' },
    ]);
  });

  it('ignores the no newline at end of file marker', () => {
    const result = parseDiffLocations([
      {
        path: 'a.ts',
        patch: ['@@ -1 +1,2 @@', ' keep', '+new', '\\ No newline at end of file'].join('\n'),
      },
    ]);
    expect(result).toEqual([{ file: 'a.ts', line: 2, side: 'RIGHT' }]);
  });

  it('ignores patch header lines if present', () => {
    const result = parseDiffLocations([
      {
        path: 'a.ts',
        patch: ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', ' keep', '+new'].join('\n'),
      },
    ]);
    expect(result).toEqual([{ file: 'a.ts', line: 2, side: 'RIGHT' }]);
  });
});

describe('isValidCommentLocation', () => {
  const locations = [
    { file: 'a.ts', line: 5, side: 'RIGHT' as const },
    { file: 'b.ts', line: 10, side: 'RIGHT' as const },
  ];

  it('returns true for a known file and line', () => {
    expect(isValidCommentLocation(locations, 'a.ts', 5)).toBe(true);
  });

  it('returns false for a line not in the diff', () => {
    expect(isValidCommentLocation(locations, 'a.ts', 6)).toBe(false);
  });

  it('returns false for an unknown file', () => {
    expect(isValidCommentLocation(locations, 'c.ts', 5)).toBe(false);
  });
});
