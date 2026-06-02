/**
 * Cross-vendor verification experiment (Experiment 6).
 *
 * Experiment 3 ran the verification gate with a same-vendor panel (gpt-5.5 and
 * gpt-5.3-codex). docs/evaluation.md flags this as a limitation, because a
 * verifier from the same family as the base model may share its blind spots and
 * inflate the apparent precision gain. This script re-runs the gate over the
 * same 26 findings the deployed model (gpt-5.4-mini) posted, using a
 * CROSS-VENDOR verifier, and compares the per-finding verdicts against the
 * same-vendor panel.
 *
 * Question: does a cross-vendor verifier kill the same noise the same-vendor
 * panel did, especially mini's 3 confident false-positive criticals?
 *
 * Run (Gemini is the default verifier):
 *   npx tsx eval/crossvendor-verify.ts
 *   CV_VERIFIERS=anthropic/claude-opus-4.8 npx tsx eval/crossvendor-verify.ts
 * Needs .env.local with OPENAI_API_KEY and OPENAI_BASE_URL set to OpenRouter.
 * Output: eval/eval-verify-crossvendor-<verifier>.jsonl
 *
 * Vendor note: Opus 4.8 returned a provider-routing 404 as a GENERATOR in the
 * noise panel, but completed all 26 calls as a VERIFIER here. Gemini 3.1 Pro
 * completed 20/22 as a generator and all 26 as a verifier. The default verifier
 * is Gemini; pass CV_VERIFIERS to run another vendor.
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

// Cross-vendor verifier(s). Defaults to Gemini (see header note on Opus).
// Override with CV_VERIFIERS (comma-separated) to try another vendor.
const VERIFIERS = (process.env.CV_VERIFIERS ?? 'google/gemini-3.1-pro-preview')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Real OpenRouter prices (USD per million tokens), fetched from the public
// models API on 2026-06-02. Used to report the actual spend of this run.
const PRICE: Record<string, { in: number; out: number }> = {
  'google/gemini-3.1-pro-preview': { in: 2, out: 12 },
  'anthropic/claude-opus-4.8': { in: 5, out: 25 },
};

const MINI = resolve(process.cwd(), 'eval/eval-results-openai_gpt-5.4-mini.jsonl');
const PRS = resolve(process.cwd(), 'eval/eval-prs.json');
const SAMEVENDOR = resolve(process.cwd(), 'eval/eval-verify-results.jsonl');
const tag = VERIFIERS.map((m) => m.split('/')[1] ?? m)
  .join('+')
  .replace(/[^\w.+-]/g, '_');
const OUT = resolve(process.cwd(), `eval/eval-verify-crossvendor-${tag}.jsonl`);

const Verdict = z.object({
  verdict: z.enum(['real', 'false_positive']),
  reason: z.string(),
});

// Identical instruction to the same-vendor run so the only variable is the
// verifier's vendor.
const SYSTEM = `You audit a single code-review comment that another AI produced about a pull-request diff. Decide whether it is a REAL, correct, worth-posting issue or a FALSE POSITIVE.
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

const usage: Record<string, { input: number; output: number; calls: number }> = {};

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

// key a finding by pr:file:line so cross-vendor and same-vendor rows line up.
function key(f: { pr: number; file: string; line: number }): string {
  return `${f.pr}:${f.file}:${f.line}`;
}

function sameVendorConsensus(): Map<string, boolean> {
  // Returns key -> true when the same-vendor panel KILLED the finding (bothFP).
  const m = new Map<string, boolean>();
  for (const l of readFileSync(SAMEVENDOR, 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(l);
    m.set(key(r), r.bothFP === true);
  }
  return m;
}

async function verify(model: string, f: Finding, patch: string) {
  const user = `PR: ${f.repo} #${f.pr} - ${f.title}
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
    const u = c.usage;
    const acc = usage[model] ?? { input: 0, output: 0, calls: 0 };
    acc.input += u?.prompt_tokens ?? 0;
    acc.output += u?.completion_tokens ?? 0;
    acc.calls += 1;
    usage[model] = acc;
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
  const sameVendor = sameVendorConsensus();
  console.log(`Findings: ${findings.length}   Cross-vendor verifier(s): ${VERIFIERS.join(', ')}\n`);

  const results = [];
  for (const f of findings) {
    const fileObj = (files.get(f.pr) || []).find((x) => x.filename === f.file);
    const patch = fileObj?.patch ?? (files.get(f.pr) || []).map((x) => x.patch).join('\n');
    const verdicts: Record<string, { verdict: string; reason: string }> = {};
    for (const m of VERIFIERS) verdicts[m] = await verify(m, f, patch);
    const vlist = VERIFIERS.map((m) => verdicts[m].verdict);
    const allFP = vlist.every((v) => v === 'false_positive');
    const sameKilled = sameVendor.get(key(f));
    results.push({ ...f, verdicts, crossVendorKilled: allFP, sameVendorKilled: sameKilled });
    console.log(
      `#${f.pr} ${f.file}:${f.line} [${f.category} ${f.confidence}] cross=${allFP ? 'KILL' : vlist.join(',')}  same=${sameKilled ? 'KILL' : 'kept'}`,
    );
  }
  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const crossKill = results.filter((r) => r.crossVendorKilled).length;
  const sameKill = results.filter((r) => r.sameVendorKilled).length;
  const agree = results.filter((r) => r.crossVendorKilled === r.sameVendorKilled).length;
  const errs = results.filter((r) =>
    VERIFIERS.some((m) => r.verdicts[m].verdict === 'error'),
  ).length;
  console.log(`\n=== CROSS-VENDOR vs SAME-VENDOR (over mini's ${results.length} findings) ===`);
  console.log(
    `cross-vendor killed (false_positive): ${crossKill}/${results.length}   (errors: ${errs})`,
  );
  console.log(`same-vendor killed (both FP):         ${sameKill}/${results.length}`);
  console.log(`per-finding agreement:                ${agree}/${results.length}`);
  console.log(`\nThe 3 confident criticals mini made:`);
  for (const r of results.filter(
    (x) => [10922, 50504, 36553].includes(x.pr) && x.confidence >= 0.9,
  )) {
    console.log(
      `  #${r.pr} ${r.file} (conf ${r.confidence}): cross=${r.crossVendorKilled ? 'KILL' : VERIFIERS.map((m) => r.verdicts[m].verdict).join(',')}  same=${r.sameVendorKilled ? 'KILL' : 'kept'}`,
    );
  }
  let totalUsd = 0;
  console.log(`\n=== ACTUAL SPEND ===`);
  for (const m of Object.keys(usage)) {
    const p = PRICE[m] ?? { in: 0, out: 0 };
    const cost = (usage[m].input * p.in + usage[m].output * p.out) / 1e6;
    totalUsd += cost;
    console.log(
      `  ${m}: ${usage[m].calls} calls, ${usage[m].input} in + ${usage[m].output} out tokens -> $${cost.toFixed(4)}`,
    );
  }
  console.log(`  TOTAL: $${totalUsd.toFixed(4)}`);
  console.log(`\n-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
