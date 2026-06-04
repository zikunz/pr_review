/**
 * Recall experiment. Feeds the bot's real review logic (same SYSTEM_PROMPT +
 * buildUserPrompt + ReviewOutput schema + diff-anchor gate) a set of small diffs,
 * each with ONE planted, diff-self-evident bug a senior reviewer must catch.
 * Measures recall per model (mini / gpt-5.5 / codex): does it flag the planted bug?
 *
 * Run: npx tsx eval/eval-recall.ts   (needs .env.local OPENAI_API_KEY/BASE_URL)
 * Output: eval/eval-recall-results.jsonl  (then judged by hand against the known bug)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { ReviewOutput } from '@/openai/schema';
import { RECALL_FIXTURES as FIXTURES } from './recall-fixtures';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  const v = t
    .slice(i + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!(k in process.env)) process.env[k] = v;
}

const MODELS = ['openai/gpt-5.4-mini', 'openai/gpt-5.5', 'openai/gpt-5.3-codex'];

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

async function review(model: string, fx: (typeof FIXTURES)[number]) {
  const files = [{ filename: fx.file, patch: fx.patch }];
  const locations = parseDiffLocations([{ path: fx.file, patch: fx.patch }]);
  try {
    const c = await client.chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt({ prTitle: fx.title, prBody: null, files }) },
      ],
      response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
      max_completion_tokens: 16000,
    });
    const r = c.choices[0]?.message?.parsed;
    if (!r) return { error: 'no parsed review' };
    const posted = (r.findings || []).filter((f) =>
      isValidCommentLocation(locations, f.file, f.line),
    );
    return { posted };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message?.slice(0, 110)}` };
  }
}

async function main() {
  const results = [];
  for (const fx of FIXTURES) {
    console.log(`\n### ${fx.id} - planted bug: ${fx.bug}`);
    const byModel: Record<string, unknown> = {};
    for (const m of MODELS) {
      const r = await review(m, fx);
      byModel[m] = r;
      if ('error' in r) {
        console.log(`  ${m.split('/')[1]}: ERROR ${r.error}`);
      } else {
        console.log(`  ${m.split('/')[1]}: ${r.posted.length} finding(s)`);
        for (const f of r.posted)
          console.log(`     [${f.severity}|${f.category}] ${f.message.slice(0, 110)}`);
      }
    }
    results.push({ ...fx, byModel });
  }
  writeFileSync(
    resolve(process.cwd(), 'eval/eval-recall-results.jsonl'),
    `${results.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
  console.log(
    `\n-> eval/eval-recall-results.jsonl  (judge caught/missed by hand against each planted bug)`,
  );
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
