/**
 * Experiment 13: do the bot's one-click fix suggestions actually fix the bug?
 *
 * Runs the deployed model's exact review path over the 8 planted-bug fixtures,
 * each a small diff with one known, diff-evident bug and a known correct fix.
 * Collects the `suggestion` field on each finding so the bot's one-click fixes
 * can be hand-scored against the planted bug (verdicts in
 * eval/suggestion-scores.md). Measures how often the bot offers a suggestion at
 * all, separate from whether the suggestion is correct.
 *
 * Run: npx tsx eval/suggestion-eval.ts   (needs .env.local with OPENAI_API_KEY)
 * Output: eval/eval-suggestions.jsonl
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { ReviewOutput } from '@/openai/schema';
import { RECALL_FIXTURES } from './recall-fixtures';

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

const MODEL = process.env.SUGG_EVAL_MODEL ?? 'openai/gpt-5.4-mini';
const OUT = resolve(process.cwd(), 'eval/eval-suggestions.jsonl');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  timeout: 60_000,
  ...(process.env.OPENAI_BASE_URL?.includes('openrouter.ai')
    ? {
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/zikunz/pr_review',
          'X-Title': 'PR Cascade',
        },
      }
    : {}),
});

async function main(): Promise<void> {
  console.log(`Suggestion quality over ${RECALL_FIXTURES.length} planted bugs  model=${MODEL}\n`);
  const results = [];
  for (const fx of RECALL_FIXTURES) {
    let findings: Array<{
      file: string;
      line: number;
      severity: string;
      message: string;
      suggestion: string | null;
    }> = [];
    try {
      const c = await client.chat.completions.parse({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt({
              prTitle: fx.title,
              prBody: null,
              files: [{ filename: fx.file, patch: fx.patch }],
            }),
          },
        ],
        response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
        max_completion_tokens: 4000,
      });
      findings = (c.choices[0]?.message?.parsed?.findings ?? []) as typeof findings;
    } catch (e) {
      console.log(`### ${fx.id}: ERROR ${(e as Error).message.slice(0, 100)}`);
    }
    results.push({
      id: fx.id,
      bug: fx.bug,
      file: fx.file,
      findings: findings.map((f) => ({
        line: f.line,
        severity: f.severity,
        message: f.message,
        suggestion: f.suggestion,
      })),
    });
    console.log(`### ${fx.id}  (${fx.bug})`);
    for (const f of findings) {
      console.log(`  [${f.severity}] ${f.file}:${f.line}  ${f.message.slice(0, 80)}`);
      console.log(
        `    suggestion: ${f.suggestion === null ? '(none)' : JSON.stringify(f.suggestion)}`,
      );
    }
    console.log('');
  }

  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const total = results.length;
  const withSugg = results.filter((r) => r.findings.some((f) => f.suggestion)).length;
  const totalSugg = results.reduce((s, r) => s + r.findings.filter((f) => f.suggestion).length, 0);
  console.log(`=== SUMMARY: suggestions over ${total} planted bugs (model ${MODEL}) ===`);
  console.log(`planted bugs where the bot offered at least one suggestion: ${withSugg}/${total}`);
  console.log(`total suggestions offered: ${totalSugg}`);
  console.log(`(correctness is hand-scored against the planted bug in eval/suggestion-scores.md)`);
  console.log(`-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
