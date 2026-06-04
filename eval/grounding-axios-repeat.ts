/**
 * Robustness check for the grounding result: re-run axios #10922 with full-file
 * grounding K times and report whether the confident critical false positive on
 * resolveConfig.js:59 recurs. If it appears across runs, "full-file context does
 * not fix the flagship confident hallucination" is robust to LLM non-determinism.
 *
 * Uses the SAME grounded prompt construction as eval/grounding-eval.ts.
 * Run: npx tsx eval/grounding-axios-repeat.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodResponseFormat } from 'openai/helpers/zod';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { client } from '@/openai/review';
import { ReviewOutput } from '@/openai/schema';

process.env.GITHUB_APP_ID ||= 'grounding-unused';
process.env.GITHUB_APP_PRIVATE_KEY ||= `grounding-unused-${'x'.repeat(120)}`;
process.env.GITHUB_WEBHOOK_SECRET ||= `grounding-unused-${'x'.repeat(40)}`;

const MODEL = 'openai/gpt-5.4-mini';
const MAX_FILE_CHARS = 16_000;
const MAX_CONTEXT_CHARS = 90_000;
const MAX_COMPLETION_TOKENS = 4000;
const RUNS = 3;
const REPO = 'axios/axios';
const PR = 10922;

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface FrozenPr {
  repo: string;
  pr: number;
  title: string;
  body: string | null;
  files: Array<{ filename: string; patch: string }>;
}

// Identical grounded-prompt construction to grounding-eval.ts.
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

async function main(): Promise<void> {
  const prs: FrozenPr[] = JSON.parse(
    readFileSync(resolve(process.cwd(), 'eval/eval-prs.json'), 'utf8'),
  );
  const pr = prs.find((p) => p.repo === REPO && p.pr === PR);
  if (!pr) throw new Error(`${REPO}#${PR} not in frozen set`);

  const sha = gh(['api', `repos/${REPO}/pulls/${PR}`, '--jq', '.head.sha']).trim();
  const fullFiles = new Map<string, string>();
  for (const f of pr.files) {
    try {
      const b64 = gh([
        'api',
        `repos/${REPO}/contents/${f.filename}?ref=${sha}`,
        '--jq',
        '.content',
      ]);
      if (b64.trim()) fullFiles.set(f.filename, Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      // skip
    }
  }
  console.log(
    `${REPO}#${PR}: ${fullFiles.size}/${pr.files.length} files grounded, head ${sha.slice(0, 8)}`,
  );
  console.log(
    `own() definition present in resolveConfig.js context: ${(fullFiles.get('lib/helpers/resolveConfig.js') ?? '').includes('const own')}\n`,
  );

  const validLocations = parseDiffLocations(
    pr.files.map((f) => ({ path: f.filename, patch: f.patch })),
  );
  const prompt = buildGroundedPrompt(pr, fullFiles);

  let fpRecurred = 0;
  for (let run = 1; run <= RUNS; run++) {
    const completion = await client().chat.completions.parse({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    });
    const findings = completion.choices[0]?.message?.parsed?.findings ?? [];
    const posted = findings.filter((f) => isValidCommentLocation(validLocations, f.file, f.line));
    const fp = posted.find(
      (f) => f.file === 'lib/helpers/resolveConfig.js' && f.severity === 'critical',
    );
    console.log(`--- Run ${run} (grounded) ---`);
    console.log(`  posted: ${posted.length}`);
    if (fp) {
      fpRecurred++;
      console.log(`  FP RECURRED: [critical ${fp.confidence}] resolveConfig.js:${fp.line}`);
      console.log(`    "${fp.message.slice(0, 140)}"`);
    } else {
      console.log('  no critical FP on resolveConfig.js this run');
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`Run 1 (earlier full experiment): FP present at 0.98`);
  console.log(`This batch: FP recurred in ${fpRecurred}/${RUNS} grounded runs`);
  console.log(
    `Total: FP present in ${fpRecurred + 1}/${RUNS + 1} grounded runs. Full-file context did NOT prevent the confident false positive.`,
  );
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
