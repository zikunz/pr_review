/**
 * Experiment 14: is the PR walkthrough accurate and does it cover the change?
 *
 * Runs the shipping walkthrough generator (src/openai/walkthrough.ts) over a
 * curated sample of the frozen PRs, spanning trivial single-file changes to
 * multi-file features. Collects the walkthrough items so accuracy (is each item
 * a real change, no hallucination?) and coverage (does it name the principal
 * change?) can be hand-scored against the diff (verdicts in
 * eval/walkthrough-scores.md).
 *
 * Run: npx tsx eval/walkthrough-eval.ts   (needs .env.local with OPENAI_API_KEY)
 * Output: eval/eval-walkthrough.jsonl
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateWalkthrough } from '@/openai/walkthrough';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  if (!(k in process.env))
    process.env[k] = t
      .slice(i + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
}
// Dummy GitHub vars so getEnv passes; the walkthrough only needs the OpenAI client.
process.env.GITHUB_APP_ID ??= '1';
process.env.GITHUB_APP_PRIVATE_KEY ??= 'x'.repeat(120);
process.env.GITHUB_WEBHOOK_SECRET ??= 'x'.repeat(40);

const MODEL = process.env.WT_EVAL_MODEL ?? 'openai/gpt-5.4-mini';
const SAMPLE = (process.env.WT_EVAL_PRS ?? '50504,10956,10929,15589,10920,10922,15580')
  .split(',')
  .map((s) => Number(s.trim()));
const PRS = resolve(process.cwd(), 'eval/eval-prs.json');
const OUT = resolve(process.cwd(), 'eval/eval-walkthrough.jsonl');

interface Pr {
  pr: number;
  repo: string;
  title: string;
  body: string | null;
  files: Array<{ filename: string; patch: string }>;
}

async function main(): Promise<void> {
  const all: Pr[] = JSON.parse(readFileSync(PRS, 'utf8'));
  const byId = new Map(all.map((p) => [p.pr, p]));
  console.log(`Walkthrough over ${SAMPLE.length} PRs  model=${MODEL}\n`);

  const results = [];
  for (const id of SAMPLE) {
    const p = byId.get(id);
    if (!p) {
      console.log(`#${id}: not in eval-prs.json`);
      continue;
    }
    const items = await generateWalkthrough(
      {
        prTitle: p.title,
        prBody: p.body,
        files: p.files.map((f) => ({ filename: f.filename, patch: f.patch })),
      },
      MODEL,
    );
    results.push({
      pr: p.pr,
      repo: p.repo,
      title: p.title,
      fileCount: p.files.length,
      files: p.files.map((f) => f.filename),
      items,
    });
    console.log(`### ${p.repo} #${p.pr}  (${p.files.length} files)  ${p.title.slice(0, 60)}`);
    console.log(`  changed files: ${p.files.map((f) => f.filename).join(', ')}`);
    for (const it of items) console.log(`  - [${it.area}]  ${it.change}`);
    console.log('');
  }

  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const totalItems = results.reduce((s, r) => s + r.items.length, 0);
  console.log(`=== SUMMARY: walkthrough over ${results.length} PRs (model ${MODEL}) ===`);
  console.log(
    `total items: ${totalItems}  (avg ${(totalItems / results.length).toFixed(1)} per PR)`,
  );
  console.log(
    `PRs with at least one item: ${results.filter((r) => r.items.length > 0).length}/${results.length}`,
  );
  console.log(
    `(accuracy and coverage are hand-scored against the diff in eval/walkthrough-scores.md)`,
  );
  console.log(`-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
