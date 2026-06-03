/**
 * Fetch reviewable merged PRs from a set of public repos, frozen to a JSON file
 * in the same shape as eval/eval-prs.json, for the large-scale precision
 * benchmark (Experiment 15). Filters to genuinely reviewable PRs: merged, not a
 * bot or dependency bump, at least one code file, and a total patch size in the
 * range the bot actually reviews.
 *
 * Run: PER_REPO=5 npx tsx eval/fetch-prs.ts   (needs gh auth)
 * Output: eval/largescale-prs.json  (skips PRs already present, so it is resumable)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPOS = (
  process.env.REPOS ??
  [
    'facebook/react',
    'vuejs/core',
    'axios/axios',
    'microsoft/TypeScript',
    'prettier/prettier',
    'angular/angular',
    'sveltejs/svelte',
    'vitejs/vite',
    'eslint/eslint',
    'babel/babel',
    'fastapi/fastapi',
    'pallets/flask',
    'django/django',
    'pandas-dev/pandas',
    'scikit-learn/scikit-learn',
    'scrapy/scrapy',
    'pydantic/pydantic',
    'langchain-ai/langchain',
    'spring-projects/spring-boot',
    'elastic/elasticsearch',
    'gin-gonic/gin',
    'hashicorp/terraform',
    'prometheus/prometheus',
    'astral-sh/ruff',
    'denoland/deno',
    'tokio-rs/tokio',
  ].join(',')
).split(',');

const PER_REPO = process.env.PER_REPO ? Number(process.env.PER_REPO) : 5;
const SCAN_PER_REPO = Math.max(20, PER_REPO * 4);
const MIN_PATCH = 200;
const MAX_PATCH = 40_000;
const OUT = resolve(process.cwd(), 'eval/largescale-prs.json');

function gh(path: string): string {
  return execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface FrozenPr {
  repo: string;
  pr: number;
  url: string;
  title: string;
  body: string | null;
  files: Array<{ filename: string; patch: string }>;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|rb|kt|c|cc|cpp|h|hpp|cs|php|scala|swift)$/;

// Exclude PRs that are not meaningful review targets: bots, dependency bumps,
// merges, reverts, and version or release PRs (which touch code but are not
// something a reviewer evaluates for correctness).
function looksUnreviewable(login: string, title: string): boolean {
  return (
    login.includes('[bot]') ||
    login.includes('dependabot') ||
    /^(chore\(deps\)|build\(deps\)|bump |merge |revert |version\b|release\b|publish\b|v?\d+\.\d+\.\d+)/i.test(
      title,
    )
  );
}

function main(): void {
  const existing: FrozenPr[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
  const seen = new Set(existing.map((p) => `${p.repo}#${p.pr}`));
  const out = [...existing];

  for (const repo of REPOS) {
    let added = 0;
    let list: Array<{
      number: number;
      title: string;
      body: string | null;
      merged_at: string | null;
      html_url: string;
      user: { login: string };
    }>;
    try {
      list = JSON.parse(
        gh(
          `repos/${repo}/pulls?state=closed&per_page=${SCAN_PER_REPO}&sort=updated&direction=desc`,
        ),
      );
    } catch (e) {
      console.log(`${repo}: list failed (${(e as Error).message.split('\n')[0].slice(0, 60)})`);
      continue;
    }
    for (const pr of list) {
      if (added >= PER_REPO) break;
      if (!pr.merged_at) continue;
      if (seen.has(`${repo}#${pr.number}`)) continue;
      if (looksUnreviewable(pr.user.login, pr.title)) continue;
      let files: Array<{ filename: string; patch?: string; status: string }>;
      try {
        files = JSON.parse(gh(`repos/${repo}/pulls/${pr.number}/files?per_page=100`));
      } catch {
        continue;
      }
      const withPatch = files.filter((f) => typeof f.patch === 'string' && f.patch.length > 0);
      const totalPatch = withPatch.reduce((s, f) => s + (f.patch as string).length, 0);
      const hasCode = withPatch.some(
        (f) => CODE_EXT.test(f.filename) && !/test|spec|__tests__/.test(f.filename),
      );
      if (totalPatch < MIN_PATCH || totalPatch > MAX_PATCH || !hasCode) continue;
      out.push({
        repo,
        pr: pr.number,
        url: pr.html_url,
        title: pr.title,
        body: pr.body,
        files: withPatch.map((f) => ({ filename: f.filename, patch: f.patch as string })),
      });
      seen.add(`${repo}#${pr.number}`);
      added += 1;
    }
    console.log(`${repo}: +${added} reviewable PRs`);
  }

  writeFileSync(OUT, `${JSON.stringify(out, null, 0)}\n`, 'utf8');
  console.log(`\ntotal frozen PRs: ${out.length}  -> ${OUT}`);
}

main();
