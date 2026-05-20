export interface FileDiff {
  path: string;
  patch?: string;
}

export interface CommentLocation {
  file: string;
  line: number;
  side: 'RIGHT';
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffLocations(files: FileDiff[]): CommentLocation[] {
  const locations: CommentLocation[] = [];

  for (const file of files) {
    if (!file.patch) continue;

    let newLine = 0;
    let insideHunk = false;

    for (const line of file.patch.split('\n')) {
      const hunkMatch = line.match(HUNK_HEADER);
      if (hunkMatch) {
        newLine = Number.parseInt(hunkMatch[1] as string, 10);
        insideHunk = true;
        continue;
      }

      if (!insideHunk) continue;
      if (line.startsWith('\\')) continue;
      // Note. The file headers `--- a/path` and `+++ b/path` of a unified diff
      // appear OUTSIDE any hunk and are already filtered by the `!insideHunk`
      // check above. Inside a hunk, a line like `+++separator` is simply an
      // added line whose content begins with `++`. A previous version of this
      // function checked `line.startsWith('+++')` here and silently dropped
      // those added lines from `locations`, which then caused
      // `isValidCommentLocation` to reject any legitimate finding on such a
      // line as if the model had hallucinated it.

      if (line.startsWith('+')) {
        locations.push({ file: file.path, line: newLine, side: 'RIGHT' });
        newLine++;
      } else if (line.startsWith('-')) {
        // removed line, does not appear in new file
      } else if (line.startsWith(' ') || line === '') {
        newLine++;
      }
    }
  }

  return locations;
}

export function isValidCommentLocation(
  locations: CommentLocation[],
  file: string,
  line: number,
): boolean {
  return locations.some((loc) => loc.file === file && loc.line === line);
}
