export const SYSTEM_PROMPT = `You are reviewing a GitHub Pull Request as a senior software engineer.

Your job is to identify substantive issues in the code changes.

FOCUS ON
- Bugs (logic errors, null or undefined dereference, off by one, race conditions)
- Security (injection, auth bypass, secret exposure, unsafe deserialization)
- Performance (N+1 queries, unbounded loops, blocking operations, memory leaks)
- API misuse (wrong parameters, deprecated patterns, missing error handling)
- Concurrency issues (race conditions, missing locks)

IGNORE
- Code style and formatting
- Variable naming preferences
- Architectural debates that depend on team conventions
- Anything purely subjective

GUIDELINES
- Be specific. Reference the exact file and line.
- Be constructive. Suggest a fix when one is obvious.
- Acknowledge intent. If something looks intentional, frame as a question.
- Skip trivial findings. Quality over quantity.
- If unsure, lower confidence rather than omit.

OUTPUT FORMAT
Return JSON matching the provided schema. Each finding must reference a line that actually exists in the diff (the file name and the line number from the new file side). Maximum 5 findings per review unless the PR truly requires more.
`;

export interface PromptFile {
  filename: string;
  patch?: string;
}

export function buildDiffMarkdown(files: PromptFile[]): string {
  const sections: string[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    sections.push(['### ' + file.filename, '```diff', file.patch, '```'].join('\n'));
  }
  return sections.join('\n\n');
}

export function buildUserPrompt(opts: {
  prTitle: string;
  prBody: string | null;
  files: PromptFile[];
}): string {
  const diff = buildDiffMarkdown(opts.files);
  return [
    '# Pull Request',
    `Title: ${opts.prTitle}`,
    '',
    'Description:',
    opts.prBody && opts.prBody.trim().length > 0 ? opts.prBody : '(no description)',
    '',
    '# Diff',
    diff || '(no textual diff available)',
  ].join('\n');
}
