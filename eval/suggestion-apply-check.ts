/**
 * Suggestion applyability check (real GitHub).
 *
 * Validates that the bot's one-click fixes from Experiment 13 are not just
 * well-formed strings but real, applyable GitHub suggestions. It reconstructs
 * the planted-bug fixture files, opens a scratch pull request containing them,
 * posts each suggestion as a real ```suggestion review comment on its line, and
 * checks that GitHub accepts and anchors each one (the precondition for the
 * one-click "Commit suggestion" affordance). It always cleans up: the PR is
 * closed and the branch deleted in a finally block.
 *
 * Run: npx tsx eval/suggestion-apply-check.ts   (needs gh auth with write access)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { longestBacktickRun } from '@/openai/prompt';
import { RECALL_FIXTURES } from './recall-fixtures';

const REPO = 'zikunz/pr_review';
const BRANCH = `test/suggestion-apply-${process.env.APPLY_CHECK_TAG ?? 'run'}`;

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, input });
}
function ghJson(path: string, fields: Record<string, string | number>, method = 'POST'): string {
  const payload = JSON.stringify(fields);
  return gh(['api', '-X', method, `repos/${REPO}/${path}`, '--input', '-'], payload);
}

// Reconstruct a fixture file's content from its new-file patch (drop the @@
// header, strip the leading + from each added line).
function fileFromPatch(patch: string): string {
  return patch
    .split('\n')
    .filter((l) => !l.startsWith('@@'))
    .map((l) => (l.startsWith('+') ? l.slice(1) : l))
    .join('\n');
}

function suggestionBody(suggestion: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(suggestion) + 1));
  return `Applyability check.\n${fence}suggestion\n${suggestion}\n${fence}`;
}

async function main(): Promise<void> {
  const suggestions: Array<{ id: string; file: string; line: number; suggestion: string }> = [];
  for (const r of readFileSync(resolve(process.cwd(), 'eval/eval-suggestions.jsonl'), 'utf8')
    .trim()
    .split('\n')) {
    const row = JSON.parse(r);
    for (const f of row.findings) {
      if (f.suggestion)
        suggestions.push({ id: row.id, file: row.file, line: f.line, suggestion: f.suggestion });
    }
  }
  const filesNeeded = new Map<string, string>();
  for (const fx of RECALL_FIXTURES) {
    if (suggestions.some((s) => s.file === fx.file))
      filesNeeded.set(fx.file, fileFromPatch(fx.patch));
  }
  console.log(`Validating ${suggestions.length} suggestions across ${filesNeeded.size} files\n`);

  const mainSha = gh(['api', `repos/${REPO}/git/ref/heads/main`, '--jq', '.object.sha']).trim();
  let prNumber: number | undefined;
  try {
    ghJson('git/refs', { ref: `refs/heads/${BRANCH}`, sha: mainSha });
    for (const [path, content] of filesNeeded) {
      ghJson(
        `contents/${path}`,
        {
          message: `add ${path} for applyability check`,
          content: Buffer.from(content).toString('base64'),
          branch: BRANCH,
        },
        'PUT',
      );
    }
    const pr = JSON.parse(
      ghJson('pulls', {
        title: 'test: suggestion applyability check (auto-cleaned)',
        head: BRANCH,
        base: 'main',
        body: 'Temporary PR to verify the bot suggestions are applyable. Auto-closed.',
      }),
    );
    prNumber = pr.number;
    const headSha = pr.head.sha as string;
    console.log(`scratch PR #${prNumber} (head ${headSha.slice(0, 7)})\n`);

    let accepted = 0;
    for (const s of suggestions) {
      try {
        const c = JSON.parse(
          ghJson(`pulls/${prNumber}/comments`, {
            commit_id: headSha,
            path: s.file,
            line: s.line,
            side: 'RIGHT',
            body: suggestionBody(s.suggestion),
          }),
        );
        const ok = typeof c.id === 'number' && c.line === s.line && c.path === s.file;
        if (ok) accepted += 1;
        console.log(`  ${ok ? 'ACCEPTED' : 'REJECTED'}  ${s.id}  ${s.file}:${s.line}`);
      } catch (e) {
        console.log(
          `  REJECTED  ${s.id}  ${s.file}:${s.line}  (${(e as Error).message.split('\n')[0].slice(0, 80)})`,
        );
      }
    }
    console.log(
      `\n=== ${accepted}/${suggestions.length} suggestions accepted by GitHub as applyable ===`,
    );
  } finally {
    if (prNumber) {
      try {
        ghJson(`pulls/${prNumber}`, { state: 'closed' }, 'PATCH');
        console.log(`closed PR #${prNumber}`);
      } catch {}
    }
    try {
      gh(['api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${BRANCH}`]);
      console.log(`deleted branch ${BRANCH}`);
    } catch {}
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
