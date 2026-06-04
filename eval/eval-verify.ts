/**
 * v0.3 verification-layer experiment.
 *
 * Takes the deployed model's (gpt-5.4-mini) 26 posted findings from the baseline
 * eval and runs a refutation-first verifier panel (gpt-5.5 + gpt-5.3-codex) over
 * each one, judging real vs false_positive FROM THE DIFF ALONE. Measures how many
 * of mini's findings the panel kills, i.e., whether a verification layer cuts
 * the noise mini produced (especially its 3 confident hallucinations).
 *
 * Run: npx tsx eval/eval-verify.ts   (needs .env.local with OPENAI_API_KEY/BASE_URL)
 * Output: eval/eval-verify-results.jsonl
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

// Minimal .env.local loader (avoid importing @/env, which validates GitHub vars).
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

const VERIFIERS = ['openai/gpt-5.5', 'openai/gpt-5.3-codex'];
const MINI = resolve(process.cwd(), 'eval/eval-results-openai_gpt-5.4-mini.jsonl');
const PRS = resolve(process.cwd(), 'eval/eval-prs.json');
const OUT = resolve(process.cwd(), 'eval/eval-verify-results.jsonl');

const Verdict = z.object({
  verdict: z.enum(['real', 'false_positive']),
  reason: z.string(),
});

const SYSTEM = `You audit a single code-review comment that another tool produced about a pull-request diff. Decide whether it is a REAL, correct, worth-posting issue or a FALSE POSITIVE.
Be refutation-first: default to false_positive unless the diff itself clearly confirms a genuine bug, security issue, or change worth flagging to the author. Common false positives: the comment misreads a helper or API; the concern is already handled in the code; it is a vague question about an intentional change; it is a trivial nitpick. Code in a merged PR is usually correct.
Judge only from the provided diff. If you cannot confirm the issue is real from the diff, it is false_positive. Return the verdict and a one-sentence reason.`;

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

interface Finding {
  repo: string;
  pr: number;
  file: string;
  line: number;
  severity: string;
  category: string;
  confidence: number;
  message: string;
  title: string;
}

function loadFindings(): Finding[] {
  const out: Finding[] = [];
  for (const l of readFileSync(MINI, 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(l);
    for (const f of r.posted || []) {
      out.push({
        repo: r.repo,
        pr: r.pr,
        title: r.title,
        file: f.file,
        line: f.line,
        severity: f.severity,
        category: f.category,
        confidence: f.confidence,
        message: f.message,
      });
    }
  }
  return out;
}

function prFiles(): Map<number, Array<{ filename: string; patch: string }>> {
  const m = new Map<number, Array<{ filename: string; patch: string }>>();
  for (const p of JSON.parse(readFileSync(PRS, 'utf8'))) m.set(p.pr, p.files);
  return m;
}

async function verify(model: string, f: Finding, patch: string) {
  const user = `PR: ${f.repo} #${f.pr} — ${f.title}
Finding to audit: [${f.severity} | ${f.category}] on ${f.file}:${f.line}
"${f.message}"

Diff of ${f.file}:
${patch.slice(0, 30000)}`;
  try {
    const c = await client.chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: zodResponseFormat(Verdict, 'verdict'),
      max_completion_tokens: 16000,
    });
    const p = c.choices[0]?.message?.parsed;
    return p
      ? { verdict: p.verdict, reason: p.reason }
      : { verdict: 'error', reason: 'no parsed verdict' };
  } catch (e) {
    return {
      verdict: 'error',
      reason: `${(e as Error).name}: ${(e as Error).message?.slice(0, 120)}`,
    };
  }
}

async function main() {
  const findings = loadFindings();
  const files = prFiles();
  console.log(`Findings to verify: ${findings.length}   Verifiers: ${VERIFIERS.join(', ')}\n`);

  const results = [];
  for (const f of findings) {
    const fileObj = (files.get(f.pr) || []).find((x) => x.filename === f.file);
    const patch = fileObj?.patch ?? (files.get(f.pr) || []).map((x) => x.patch).join('\n');
    const verdicts: Record<string, { verdict: string; reason: string }> = {};
    for (const m of VERIFIERS) verdicts[m] = await verify(m, f, patch);
    const vlist = VERIFIERS.map((m) => verdicts[m].verdict);
    const bothReal = vlist.every((v) => v === 'real');
    const bothFP = vlist.every((v) => v === 'false_positive');
    results.push({ ...f, verdicts, bothReal, bothFP });
    console.log(
      `#${f.pr} ${f.file}:${f.line} [${f.category} ${f.confidence}] -> ${VERIFIERS.map((m) => `${m.split('/')[1]}:${verdicts[m].verdict}`).join('  ')}  ${bothFP ? 'KILLED' : bothReal ? 'survives' : 'split'}`,
    );
  }
  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const bothFP = results.filter((r) => r.bothFP).length;
  const bothReal = results.filter((r) => r.bothReal).length;
  const split = results.length - bothFP - bothReal;
  console.log(`\n=== SUMMARY (verification layer over mini's ${results.length} findings) ===`);
  console.log(
    `KILLED by consensus (both verifiers say false_positive): ${bothFP}/${results.length}`,
  );
  console.log(`survived (both say real): ${bothReal}/${results.length}`);
  console.log(`split (1 real / 1 FP): ${split}/${results.length}`);
  for (const m of VERIFIERS) {
    const fp = results.filter((r) => r.verdicts[m].verdict === 'false_positive').length;
    const err = results.filter((r) => r.verdicts[m].verdict === 'error').length;
    console.log(`  ${m}: called false_positive on ${fp}/${results.length}  (errors: ${err})`);
  }
  console.log(`\nThe 3 confident FPs mini made:`);
  for (const r of results.filter(
    (x) => [10922, 50504, 36553].includes(x.pr) && x.confidence >= 0.9,
  )) {
    console.log(
      `  #${r.pr} ${r.file} (conf ${r.confidence}): ${VERIFIERS.map((m) => `${m.split('/')[1]}=${r.verdicts[m].verdict}`).join('  ')}`,
    );
  }
  console.log(`\n-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
