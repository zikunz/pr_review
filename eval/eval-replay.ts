/**
 * Offline eval replay harness for PR Cascade.
 *
 * Feeds real, already-merged PRs from public repos through the bot's EXACT
 * review path (callReview + the diff-anchor gate) without forking, opening PRs,
 * or the GitHub webhook. It imports the bot's real functions from src/, so this
 * is the bot's own review logic, not a reimplementation.
 *
 * Two stages so every model sees the SAME PRs (fair comparison):
 *   npx tsx eval/eval-replay.ts --select            (fetch + freeze the PR set, no key)
 *   npx tsx eval/eval-replay.ts --model <slug>      (run one model over the frozen set)
 *
 * The --model stage needs .env.local with OPENAI_API_KEY (+ OPENAI_BASE_URL).
 * PRs are fetched via the local `gh` auth. No GitHub App key is needed, so the
 * dummy GitHub values below only satisfy env validation.
 *
 * Output: eval/eval-results-<model>.jsonl, one line per PR, each posted
 * finding carrying empty "label"/"tag" fields to fill per the scoring rubric in docs/evaluation.md.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import type { PromptFile } from '@/openai/prompt';
import { callReview } from '@/openai/review';

// getEnv() validates these. The replay never uses GitHub App auth (PRs come via
// the gh CLI). Force valid-shaped dummies so validation passes regardless.
process.env.GITHUB_APP_ID = 'replay-unused';
process.env.GITHUB_APP_PRIVATE_KEY = `replay-unused-${'x'.repeat(120)}`;
process.env.GITHUB_WEBHOOK_SECRET = `replay-unused-${'x'.repeat(40)}`;

const TARGETS = [
  { owner: 'facebook', repo: 'react' },
  { owner: 'fastapi', repo: 'fastapi' },
  { owner: 'spring-projects', repo: 'spring-boot' },
  { owner: 'axios', repo: 'axios' },
];
const PER_REPO = 6;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|c|cc|cpp|h|hpp)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$/i;
const MIN_PATCH_CHARS = 200;
const MAX_PATCH_CHARS = 40_000;
const PRS_FILE = resolve(process.cwd(), 'eval/eval-prs.json');

interface GhFile {
  filename: string;
  patch?: string;
}
interface GhPull {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  html_url: string;
}
interface SelectedPr {
  repo: string;
  pr: number;
  url: string;
  title: string;
  body: string | null;
  files: Array<{ filename: string; patch: string }>;
}

function gh<T>(path: string): T {
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
}

function select(): void {
  const selected: SelectedPr[] = [];
  for (const { owner, repo } of TARGETS) {
    console.log(`\n=== ${owner}/${repo} ===`);
    let merged: GhPull[];
    try {
      const pulls = gh<GhPull[]>(
        `repos/${owner}/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=80`,
      );
      merged = pulls.filter((p) => p.merged_at !== null);
    } catch (e) {
      console.log(`  fetch pulls failed: ${(e as Error).message?.slice(0, 160)}`);
      continue;
    }

    let kept = 0;
    for (const pull of merged) {
      if (kept >= PER_REPO) break;
      let files: GhFile[];
      try {
        files = gh<GhFile[]>(`repos/${owner}/${repo}/pulls/${pull.number}/files?per_page=100`);
      } catch {
        continue;
      }
      const codeFiles = files.filter(
        (f): f is { filename: string; patch: string } =>
          typeof f.patch === 'string' && CODE_EXT.test(f.filename),
      );
      const productCode = codeFiles.filter((f) => !TEST_PATH.test(f.filename));
      const totalPatch = codeFiles.reduce((n, f) => n + f.patch.length, 0);
      if (
        productCode.length === 0 ||
        totalPatch < MIN_PATCH_CHARS ||
        totalPatch > MAX_PATCH_CHARS
      ) {
        continue;
      }
      const locations = parseDiffLocations(
        codeFiles.map((f) => ({ path: f.filename, patch: f.patch })),
      );
      if (locations.length === 0) continue;

      selected.push({
        repo: `${owner}/${repo}`,
        pr: pull.number,
        url: pull.html_url,
        title: pull.title,
        body: pull.body,
        files: codeFiles.map((f) => ({ filename: f.filename, patch: f.patch })),
      });
      console.log(
        `  PR #${pull.number}  ${codeFiles.length} files  ${totalPatch} chars  - ${pull.title.slice(0, 60)}`,
      );
      kept++;
    }
    console.log(`  kept ${kept}`);
  }

  writeFileSync(PRS_FILE, JSON.stringify(selected, null, 2), 'utf8');
  console.log(`\nFrozen ${selected.length} PRs -> ${PRS_FILE}`);
}

async function runModel(model: string): Promise<void> {
  if (!existsSync(PRS_FILE)) {
    console.error(`No frozen PR set. Run:  npx tsx eval/eval-replay.ts --select`);
    process.exit(1);
  }
  const prs: SelectedPr[] = JSON.parse(readFileSync(PRS_FILE, 'utf8'));
  console.log(`Model: ${model}   PRs: ${prs.length}\n`);

  const results = [];
  for (const pr of prs) {
    const promptFiles: PromptFile[] = pr.files.map((f) => ({
      filename: f.filename,
      patch: f.patch,
    }));
    const locations = parseDiffLocations(
      pr.files.map((f) => ({ path: f.filename, patch: f.patch })),
    );
    process.stdout.write(`  ${pr.repo} #${pr.pr} ... `);
    try {
      const { review } = await callReview({
        prTitle: pr.title,
        prBody: pr.body,
        files: promptFiles,
        model,
      });
      const posted = review.findings.filter((f) =>
        isValidCommentLocation(locations, f.file, f.line),
      );
      results.push({
        repo: pr.repo,
        pr: pr.pr,
        url: pr.url,
        title: pr.title,
        model,
        rawFindings: review.findings.length,
        posted: posted.map((f) => ({
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          confidence: f.confidence,
          message: f.message,
          label: '',
          tag: '',
        })),
        dropped: review.findings.length - posted.length,
      });
      console.log(`${posted.length} posted / ${review.findings.length} raw`);
    } catch (e) {
      const msg = `${(e as Error).name}: ${(e as Error).message?.slice(0, 160)}`;
      console.log(`error: ${msg}`);
      results.push({
        repo: pr.repo,
        pr: pr.pr,
        url: pr.url,
        title: pr.title,
        model,
        rawFindings: 0,
        posted: [],
        dropped: 0,
        error: msg,
      });
    }
  }

  const safe = model.replace(/[^\w.-]/g, '_');
  const out = resolve(process.cwd(), `eval/eval-results-${safe}.jsonl`);
  writeFileSync(out, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const totalPosted = results.reduce((n, r) => n + r.posted.length, 0);
  const errors = results.filter((r) => 'error' in r && r.error).length;
  console.log(`\n=== ${model} ===`);
  console.log(`PRs ok: ${prs.length - errors}   errors: ${errors}`);
  console.log(`Findings the bot would post (diff-anchored): ${totalPosted}`);
  console.log(`-> ${out}`);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--select')) {
  select();
} else {
  const model = argValue('--model') ?? process.env.OPENAI_MODEL ?? 'openai/gpt-5.4-mini';
  await runModel(model);
}
