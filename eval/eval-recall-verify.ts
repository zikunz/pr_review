/**
 * Does the v0.3 verification layer HURT recall? Takes mini's planted-bug catches
 * (the critical finding per recall fixture) and runs the same refute-first
 * verifier panel (gpt-5.5 + gpt-5.3-codex) over them. If the verifier KEEPS them
 * (verdict real), verification cuts noise without killing real bugs.
 *
 * Run: npx tsx eval/eval-recall-verify.ts
 */
import { readFileSync } from 'node:fs';
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

const VERIFIERS = ['openai/gpt-5.5', 'openai/gpt-5.3-codex'];
const Verdict = z.object({ verdict: z.enum(['real', 'false_positive']), reason: z.string() });
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

async function verify(
  model: string,
  finding: { severity: string; category: string; file: string; line: number; message: string },
  title: string,
  patch: string,
) {
  const user = `PR: ${title}
Finding to audit: [${finding.severity} | ${finding.category}] on ${finding.file}:${finding.line}
"${finding.message}"

Diff of ${finding.file}:
${patch}`;
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
    return p ? { verdict: p.verdict, reason: p.reason } : { verdict: 'error', reason: 'no parsed' };
  } catch (e) {
    return { verdict: 'error', reason: `${(e as Error).name}` };
  }
}

async function main() {
  const fixtures = readFileSync(resolve(process.cwd(), 'eval/eval-recall-results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  let kept = 0;
  let total = 0;
  for (const fx of fixtures) {
    const mini = fx.byModel['openai/gpt-5.4-mini'];
    if (!mini || mini.error || !(mini.posted || []).length) {
      console.log(`\n### ${fx.id}: (no mini finding to verify)`);
      continue;
    }
    // the planted-bug catch = the critical finding (fall back to first)
    const catchFinding =
      (mini.posted as Array<{ severity: string }>).find((f) => f.severity === 'critical') ??
      mini.posted[0];
    total++;
    const verdicts: Record<string, { verdict: string; reason: string }> = {};
    for (const m of VERIFIERS) verdicts[m] = await verify(m, catchFinding, fx.title, fx.patch);
    const survives = VERIFIERS.every((m) => verdicts[m].verdict === 'real');
    if (survives) kept++;
    console.log(`\n### ${fx.id} (planted: ${fx.bug.slice(0, 60)})`);
    console.log(
      `  catch: [${catchFinding.severity}|${catchFinding.category}] ${catchFinding.message.slice(0, 80)}`,
    );
    for (const m of VERIFIERS)
      console.log(
        `  ${m.split('/')[1]} = ${verdicts[m].verdict}: ${verdicts[m].reason.slice(0, 120)}`,
      );
    console.log(`  -> ${survives ? 'KEPT (recall preserved)' : 'KILLED (recall HURT!)'}`);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`Planted-bug catches kept by the verifier: ${kept}/${total}`);
  console.log(
    kept === total
      ? 'Verification preserved 100% recall on the planted bugs.'
      : `WARNING: verification killed ${total - kept} real-bug finding(s).`,
  );
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
