/**
 * Grounding experiment (v0.4 candidate). Tests the canonical frontier
 * best-practice of reviewing with surrounding code, not just the diff hunk
 * ("grounding", per Greptile / CodeRabbit / arXiv:2510.10290), against the
 * project's own measured failure mode. Mini's three confident (0.96-0.98)
 * false positives were all diff-only-context artifacts (the disambiguating
 * code lived OUTSIDE the diff).
 *
 * Method: re-run the deployed model over the SAME 22 frozen PRs, but add the
 * full content of each changed file (fetched at the PR head SHA) to the prompt.
 * Same system prompt, same schema, same diff-anchor gate as the baseline, so
 * the only variable is the added file context. Compare the confident-critical
 * false positives against the diff-only baseline.
 *
 * Run: npx tsx eval/grounding-eval.ts
 * Output: eval/eval-results-grounded-mini.jsonl
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodResponseFormat } from 'openai/helpers/zod';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { client } from '@/openai/review';
import { type Finding, ReviewOutput } from '@/openai/schema';

// getEnv() validates GitHub App vars. Real .env.local OpenRouter values win.
process.env.GITHUB_APP_ID ||= 'grounding-unused';
process.env.GITHUB_APP_PRIVATE_KEY ||= `grounding-unused-${'x'.repeat(120)}`;
process.env.GITHUB_WEBHOOK_SECRET ||= `grounding-unused-${'x'.repeat(40)}`;

const MODEL = process.env.GROUNDING_MODEL ?? 'openai/gpt-5.4-mini';
const MAX_FILE_CHARS = 16_000; // per-file full-content cap
const MAX_CONTEXT_CHARS = 90_000; // total grounded-context cap per PR (well under the 200k prompt gate)
const MAX_COMPLETION_TOKENS = 4000; // matches the bot's production cap

interface FrozenPr {
  repo: string;
  pr: number;
  url: string;
  title: string;
  body: string | null;
  files: Array<{ filename: string; patch: string }>;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function headSha(repo: string, pr: number): string {
  return gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim();
}

// Fetch a file's full content at a ref. Returns null on 404 / too large / error.
function fetchFile(repo: string, path: string, ref: string): string | null {
  try {
    const b64 = gh(['api', `repos/${repo}/contents/${path}?ref=${ref}`, '--jq', '.content']);
    if (!b64.trim()) return null;
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// Build the grounded user prompt as EXACTLY the baseline prompt the bot sends
// (buildUserPrompt, diff-only) plus an appended full-file context section. This
// keeps the A/B clean: the only variable versus the diff-only baseline is the
// added surrounding-code context, with identical title/body/diff handling.
function buildGroundedPrompt(pr: FrozenPr, fullFiles: Map<string, string>): string {
  const base = buildUserPrompt({
    prTitle: pr.title,
    prBody: pr.body,
    files: pr.files.map((f) => ({ filename: f.filename, patch: f.patch })),
  });

  let used = 0;
  const contextSections: string[] = [];
  for (const f of pr.files) {
    const content = fullFiles.get(f.filename);
    if (!content) continue;
    const clipped =
      content.length > MAX_FILE_CHARS
        ? `${content.slice(0, MAX_FILE_CHARS)}\n[truncated]`
        : content;
    if (used + clipped.length > MAX_CONTEXT_CHARS) continue;
    used += clipped.length;
    const safeName = f.filename.replace(/[\r\n`]/g, '');
    const longestRun = (clipped.match(/`+/g) ?? ['']).reduce((m, s) => Math.max(m, s.length), 0);
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    contextSections.push([`### ${safeName} (full file)`, fence, clipped, fence].join('\n'));
  }

  // No full-file context available (all fetches failed) → identical to baseline.
  if (contextSections.length === 0) return base;

  return [
    base,
    '',
    '# Full file context',
    'The complete current content of each changed file is below, so you can judge each finding against the surrounding code rather than the diff alone. Only comment on lines that appear in the diff above.',
    '',
    contextSections.join('\n\n'),
  ].join('\n');
}

async function reviewGrounded(pr: FrozenPr, fullFiles: Map<string, string>): Promise<Finding[]> {
  const completion = await client().chat.completions.parse({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildGroundedPrompt(pr, fullFiles) },
    ],
    response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  });
  return completion.choices[0]?.message?.parsed?.findings ?? [];
}

async function main(): Promise<void> {
  const root = process.cwd();
  const prs: FrozenPr[] = JSON.parse(readFileSync(resolve(root, 'eval/eval-prs.json'), 'utf8'));
  const out = resolve(root, 'eval/eval-results-grounded-mini.jsonl');
  const lines: string[] = [];

  console.log(`Grounding run: model=${MODEL}, ${prs.length} PRs\n`);

  for (const pr of prs) {
    let sha: string;
    try {
      sha = headSha(pr.repo, pr.pr);
    } catch {
      console.log(`${pr.repo}#${pr.pr}: head SHA fetch failed, skipping`);
      lines.push(JSON.stringify({ repo: pr.repo, pr: pr.pr, error: 'head sha fetch failed' }));
      continue;
    }

    const fullFiles = new Map<string, string>();
    let fetched = 0;
    for (const f of pr.files) {
      const content = fetchFile(pr.repo, f.filename, sha);
      if (content) {
        fullFiles.set(f.filename, content);
        fetched++;
      }
    }

    const validLocations = parseDiffLocations(
      pr.files.map((f) => ({ path: f.filename, patch: f.patch })),
    );

    try {
      const findings = await reviewGrounded(pr, fullFiles);
      const posted = findings.filter((f) => isValidCommentLocation(validLocations, f.file, f.line));
      lines.push(
        JSON.stringify({ repo: pr.repo, pr: pr.pr, model: MODEL, filesFetched: fetched, posted }),
      );
      const crits = posted.filter((f) => f.severity === 'critical');
      console.log(
        `${pr.repo}#${pr.pr}: ${fetched}/${pr.files.length} files grounded, ${posted.length} posted` +
          (crits.length
            ? `  [${crits.map((c) => `critical ${c.confidence} ${c.file}:${c.line}`).join('; ')}]`
            : ''),
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.log(`${pr.repo}#${pr.pr}: review failed: ${reason}`);
      lines.push(JSON.stringify({ repo: pr.repo, pr: pr.pr, error: reason }));
    }
  }

  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nWrote ${out}`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
