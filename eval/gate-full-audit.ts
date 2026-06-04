/**
 * Gate-against-ground-truth audit (Experiment 9).
 *
 * Experiment 8 hand-scored all 83 findings the six configurations posted on the
 * 22 PRs (one clear true positive, two borderline, the rest false positives).
 * This script runs the shipped verification gate (the production default
 * verifier, gpt-5.5, refutation-first) over every one of those 83 findings and
 * checks two things directly against the hand-scored ground truth:
 *   - false-positive removal: how many of the findings the gate drops, which on
 *     this set is almost entirely false positives;
 *   - true-positive preservation: whether the gate keeps the one clear real bug
 *     (React PR 36566) and the two borderline findings.
 *
 * This is the strongest validation of the gate: it is measured against a
 * complete per-finding hand label rather than against itself.
 *
 * Run (needs .env.local with OpenRouter creds):
 *   npx tsx eval/gate-full-audit.ts
 * Output: eval/eval-gate-full-audit.jsonl
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

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

const VERIFIER = process.env.GATE_MODEL ?? 'openai/gpt-5.5';
const PRICE: Record<string, { in: number; out: number }> = { 'openai/gpt-5.5': { in: 5, out: 30 } };
const PRS = resolve(process.cwd(), 'eval/eval-prs.json');
const OUT = resolve(process.cwd(), 'eval/eval-gate-full-audit.jsonl');

// The six configurations and where their findings live. posted[] for the noise
// panel and grounding, finalFindings[] for the multi-agent pipeline.
const SOURCES: Array<{ label: string; file: string; key: 'posted' | 'finalFindings' }> = [
  { label: 'mini', file: 'eval/eval-results-openai_gpt-5.4-mini.jsonl', key: 'posted' },
  { label: 'gpt-5.5', file: 'eval/eval-results-openai_gpt-5.5.jsonl', key: 'posted' },
  { label: 'codex', file: 'eval/eval-results-openai_gpt-5.3-codex.jsonl', key: 'posted' },
  { label: 'gemini', file: 'eval/eval-results-google_gemini-3.1-pro-preview.jsonl', key: 'posted' },
  { label: 'grounded-mini', file: 'eval/eval-results-grounded-mini.jsonl', key: 'posted' },
  { label: 'multiagent', file: 'eval/eval-multiagent-gpt-5.5.jsonl', key: 'finalFindings' },
];

// Ground-truth labels from Experiment 8 (eval/finding-scores.md), keyed by
// pr:file:line, for the findings that are NOT false positives. Everything else
// is a false positive.
const GROUND_TRUTH: Record<string, 'true_positive' | 'borderline'> = {
  // The one clear true positive (React control-flow bug), surfaced by three
  // configurations on the same file:line.
  '36566:packages/react-server-dom-esm/src/server/ReactFlightDOMServerNode.js:395': 'true_positive',
  '36566:packages/react-server-dom-esm/src/server/ReactFlightDOMServerNode.js:401': 'true_positive',
  '36566:packages/react-server-dom-webpack/src/server/ReactFlightDOMServerNode.js:687':
    'true_positive',
  // Borderline true positive. The fastapi non-Markdown-asset finding is scored
  // as a borderline false positive in Experiment 8 (its harm is not realized in
  // the repo), so it is left in the false-positive set by default.
  '10929:lib/adapters/http.js:875': 'borderline', // axios cross-origin redirect chain (gpt-5.5)
};

const Verdict = z.object({ verdict: z.enum(['real', 'false_positive']), reason: z.string() });

const SYSTEM = `You audit a single code-review comment that another tool produced about a pull-request diff. Decide whether it is a REAL, correct, worth-posting issue or a FALSE POSITIVE.
Be refutation-first: default to false_positive unless the diff itself clearly confirms a genuine bug, security issue, or change worth flagging to the author. Common false positives: the comment misreads a helper or API; the concern is already handled in the code; it is a vague question about an intentional change; it is a trivial nitpick. Code in a merged PR is usually correct.
Judge only from the provided diff. If you cannot confirm the issue is real from the diff, it is false_positive. Return the verdict and a one-sentence reason.`;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  timeout: 90_000,
  ...(process.env.OPENAI_BASE_URL?.includes('openrouter.ai')
    ? {
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/zikunz/pr_review',
          'X-Title': 'PR Cascade',
        },
      }
    : {}),
});

interface F {
  source: string;
  pr: number;
  file: string;
  line: number;
  severity: string;
  category: string;
  confidence: number;
  message: string;
  truth: 'true_positive' | 'borderline' | 'false_positive';
}

const usage = { input: 0, output: 0, calls: 0 };

function loadAll(): F[] {
  const out: F[] = [];
  for (const s of SOURCES) {
    for (const l of readFileSync(resolve(process.cwd(), s.file), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)) {
      const r = JSON.parse(l);
      for (const f of r[s.key] ?? []) {
        const truth = GROUND_TRUTH[`${r.pr}:${f.file}:${f.line}`] ?? 'false_positive';
        out.push({
          source: s.label,
          pr: r.pr,
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          confidence: f.confidence,
          message: f.message,
          truth,
        });
      }
    }
  }
  return out;
}

function prFiles(): Map<number, Array<{ filename: string; patch: string }>> {
  const m = new Map<number, Array<{ filename: string; patch: string }>>();
  for (const p of JSON.parse(readFileSync(PRS, 'utf8'))) m.set(p.pr, p.files);
  return m;
}

async function gate(f: F, patch: string): Promise<string> {
  const user = `PR #${f.pr}
Finding to audit: [${f.severity} | ${f.category}] on ${f.file}:${f.line}
"${f.message}"

Diff of ${f.file}:
${patch.slice(0, 30000)}`;
  try {
    const c = await client.chat.completions.parse({
      model: VERIFIER,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: zodResponseFormat(Verdict, 'verdict'),
      max_completion_tokens: 16000,
    });
    usage.input += c.usage?.prompt_tokens ?? 0;
    usage.output += c.usage?.completion_tokens ?? 0;
    usage.calls += 1;
    return c.choices[0]?.message?.parsed?.verdict ?? 'error';
  } catch (e) {
    return `error:${(e as Error).message?.slice(0, 60)}`;
  }
}

async function main(): Promise<void> {
  const findings = loadAll();
  const files = prFiles();
  console.log(`Gate (${VERIFIER}) over ${findings.length} findings\n`);

  const results = [];
  for (const f of findings) {
    const fileObj = (files.get(f.pr) || []).find((x) => x.filename === f.file);
    const patch = fileObj?.patch ?? (files.get(f.pr) || []).map((x) => x.patch).join('\n');
    const verdict = await gate(f, patch);
    const dropped = verdict === 'false_positive';
    results.push({ ...f, gateVerdict: verdict, dropped });
    if (f.truth !== 'false_positive') {
      console.log(
        `  [${f.truth}] ${f.source} #${f.pr} ${f.file}:${f.line} -> gate=${verdict} ${dropped ? 'DROP' : 'KEEP'}`,
      );
    }
  }
  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const fps = results.filter((r) => r.truth === 'false_positive');
  const fpDropped = fps.filter((r) => r.dropped).length;
  const tps = results.filter((r) => r.truth === 'true_positive');
  const tpKept = tps.filter((r) => !r.dropped).length;
  const borderline = results.filter((r) => r.truth === 'borderline');
  const errs = results.filter((r) => String(r.gateVerdict).startsWith('error')).length;
  const price = PRICE[VERIFIER] ?? { in: 0, out: 0 };
  const cost = (usage.input * price.in + usage.output * price.out) / 1e6;

  console.log(`\n=== GATE vs HAND-SCORED GROUND TRUTH (${findings.length} findings) ===`);
  console.log(
    `false positives dropped by the gate: ${fpDropped}/${fps.length}  (${((100 * fpDropped) / fps.length).toFixed(0)}%)`,
  );
  console.log(`clear true positives kept by the gate: ${tpKept}/${tps.length}`);
  console.log(
    `borderline kept: ${borderline.filter((r) => !r.dropped).length}/${borderline.length}`,
  );
  console.log(`gate errors: ${errs}`);
  console.log(
    `\nspend: ${usage.calls} calls, ${usage.input} in + ${usage.output} out -> $${cost.toFixed(4)}`,
  );
  console.log(`-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
