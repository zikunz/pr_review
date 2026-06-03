/**
 * Experiment 11: agentic (tool-using) verification vs the static gate.
 *
 * The static verification gate (Experiment 3) judges each finding from the diff
 * alone, and Experiments 4 and 6 showed it leaves standing the false positives
 * whose refutation lives outside the diff (the axios `own` helper is the canonical
 * case). This experiment runs the SHIPPING agentic verifier (src/openai/verify-tools.ts)
 * over the same 26 findings the deployed model posted. The verifier can call
 * read_file and find_files to inspect the real repository at the PR head commit
 * before deciding, so it can look up the definition the finding depends on rather
 * than guessing from the description. It measures how many of mini's 26 findings
 * the agentic gate kills, against the static gate's 24, and whether it preserves
 * the one real bug.
 *
 * The verifier loop, tools, and refutation-first rule are imported from the
 * production module, so this measures the code that actually ships. Only the
 * model call and the file fetcher are supplied here (a standalone OpenRouter
 * client and a gh-CLI-backed fetcher at the PR head SHA).
 *
 * Run: npx tsx eval/verify-tools-eval.ts   (needs .env.local + gh auth)
 * Output: eval/eval-verify-tools.jsonl
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { estimateCost } from '@/lib/cost';
import {
  type CodeFetcher,
  type CompleteFn,
  sliceWithLineNumbers,
  VERIFY_TOOLS,
  verifyOneWithTools,
} from '@/openai/verify-tools';

// Minimal .env.local loader (importing @/openai/verify-tools already loads it via
// @/env, but keep this explicit and idempotent).
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

const MODEL = process.env.TOOLS_EVAL_MODEL ?? 'openai/gpt-5.5';
const LIMIT = process.env.TOOLS_EVAL_LIMIT
  ? Number(process.env.TOOLS_EVAL_LIMIT)
  : Number.POSITIVE_INFINITY;
const MAX_ITERS = 8;
const MAX_TOKENS_PER_STEP = 8000;
const SPEND_CAP_USD = 12;
const MINI = resolve(process.cwd(), 'eval/eval-results-openai_gpt-5.4-mini.jsonl');
const PRS = resolve(process.cwd(), 'eval/eval-prs.json');
const STATIC = resolve(process.cwd(), 'eval/eval-verify-results.jsonl');
// Default (gpt-5.5) writes the canonical file; other verifier models get a
// per-model file so a cross-vendor run does not overwrite the committed result.
const MODEL_SHORT = MODEL.split('/').pop() ?? MODEL;
const OUT = resolve(
  process.cwd(),
  MODEL_SHORT === 'gpt-5.5'
    ? 'eval/eval-verify-tools.jsonl'
    : `eval/eval-verify-tools-${MODEL_SHORT}.jsonl`,
);

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

const complete: CompleteFn = async (messages, opts) => {
  const c = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: VERIFY_TOOLS,
    tool_choice: opts?.forceSubmit
      ? { type: 'function', function: { name: 'submit_verdict' } }
      : 'auto',
    max_completion_tokens: MAX_TOKENS_PER_STEP,
  });
  const message = c.choices[0]?.message ?? { role: 'assistant', content: '' };
  const toolCalls = (c.choices[0]?.message?.tool_calls ?? [])
    .filter((tc) => tc.type === 'function')
    .map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments }));
  const u = c.usage;
  return {
    message,
    toolCalls,
    usage: {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
};

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const shaCache = new Map<number, string>();
function headSha(repo: string, pr: number): string {
  if (!shaCache.has(pr)) {
    try {
      shaCache.set(pr, gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim());
    } catch {
      // Some frozen PRs no longer resolve on the API (a number that is now an
      // issue, or a removed PR). Mark the SHA empty; the fetcher then reports
      // file access as unavailable and the verifier judges from the diff alone.
      shaCache.set(pr, '');
    }
  }
  return shaCache.get(pr) as string;
}

// A CodeFetcher backed by the gh CLI at the PR head commit, mirroring the
// production githubFetcher but using gh auth instead of an installation token.
function ghFetcher(repo: string, sha: string): CodeFetcher {
  if (!sha) {
    return {
      readFile: async () => 'repository file access unavailable for this pull request',
      findFiles: async () => [],
    };
  }
  const fileCache = new Map<string, string | null>();
  let tree: string[] | undefined;
  return {
    async readFile(path, startLine, endLine) {
      if (!fileCache.has(path)) {
        try {
          const raw = gh(['api', `repos/${repo}/contents/${path}?ref=${sha}`, '--jq', '.content']);
          fileCache.set(path, Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8'));
        } catch {
          fileCache.set(path, null);
        }
      }
      const content = fileCache.get(path);
      if (content == null) return `file not found at ${sha}: ${path}`;
      return sliceWithLineNumbers(content, startLine, endLine);
    },
    async findFiles(query) {
      if (!tree) {
        try {
          const raw = gh([
            'api',
            `repos/${repo}/git/trees/${sha}?recursive=1`,
            '--jq',
            '.tree[] | select(.type=="blob") | .path',
          ]);
          tree = raw.trim().split('\n').filter(Boolean);
        } catch {
          tree = [];
        }
      }
      const q = query.toLowerCase();
      return tree.filter((p) => p.toLowerCase().includes(q));
    },
  };
}

interface MiniFinding {
  repo: string;
  pr: number;
  title: string;
  file: string;
  line: number;
  severity: string;
  category: string;
  confidence: number;
  message: string;
}

function loadFindings(): MiniFinding[] {
  const out: MiniFinding[] = [];
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

// Static-gate verdict per finding, keyed by pr:file:line, so the summary can
// show where the agentic gate and the static gate disagree.
function staticKills(): Map<string, boolean> {
  const m = new Map<string, boolean>();
  try {
    for (const l of readFileSync(STATIC, 'utf8').trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(l);
      m.set(`${r.pr}:${r.file}:${r.line}`, r.bothFP === true);
    }
  } catch {
    // no static file; comparison columns stay undefined
  }
  return m;
}

async function main(): Promise<void> {
  const findings = loadFindings().slice(0, LIMIT);
  const files = prFiles();
  const staticFP = staticKills();
  console.log(
    `Agentic verification over ${findings.length} findings  model=${MODEL}  maxIters=${MAX_ITERS}\n`,
  );

  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const results = [];
  let spentCents = 0;

  for (const f of findings) {
    if (spentCents / 100 > SPEND_CAP_USD) {
      console.log(
        `\n[stopped early: spend cap $${SPEND_CAP_USD} reached after ${results.length} findings]`,
      );
      break;
    }
    const fileObj = (files.get(f.pr) || []).find((x) => x.filename === f.file);
    const patch = fileObj?.patch ?? (files.get(f.pr) || []).map((x) => x.patch).join('\n');
    const sha = headSha(f.repo, f.pr);
    const fetcher = ghFetcher(f.repo, sha);

    const {
      verdict,
      usage: u,
      toolLog,
    } = await verifyOneWithTools({
      finding: {
        file: f.file,
        line: f.line,
        severity: f.severity as never,
        category: f.category as never,
        message: f.message,
        confidence: f.confidence,
        suggestion: null,
      },
      fileDiff: [{ filename: f.file, patch }],
      fetcher,
      complete,
      model: MODEL,
      maxIters: MAX_ITERS,
    });

    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens;
    try {
      spentCents = estimateCost(
        MODEL,
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedInputTokens,
      ).totalCents;
    } catch {
      // unpriced model; spend guard stays at 0
    }

    const key = `${f.pr}:${f.file}:${f.line}`;
    const killedByStatic = staticFP.get(key);
    const killedByTools = verdict.verdict === 'false_positive';
    results.push({
      ...f,
      verdict: verdict.verdict,
      reason: verdict.reason,
      toolCalls: toolLog,
      killedByStatic,
      killedByTools,
    });
    console.log(
      `#${f.pr} ${f.file}:${f.line} [${f.category} ${f.confidence}] tools=${toolLog.length} -> ${verdict.verdict}${killedByTools ? ' KILLED' : ''}` +
        (killedByStatic === undefined ? '' : `  (static: ${killedByStatic ? 'killed' : 'kept'})`),
    );
    for (const t of toolLog) console.log(`      ${t}`);
  }

  writeFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const killed = results.filter((r) => r.killedByTools).length;
  const kept = results.length - killed;
  const errored = results.filter((r) => r.verdict === 'error').length;
  const withTools = results.filter((r) => r.toolCalls.length > 0).length;
  const totalToolCalls = results.reduce((s, r) => s + r.toolCalls.length, 0);
  console.log(`\n=== AGENTIC GATE over ${results.length} of mini's findings (model ${MODEL}) ===`);
  console.log(
    `killed (false_positive): ${killed}/${results.length}   kept: ${kept}   errored (kept, fail-open): ${errored}`,
  );
  console.log(
    `used a tool on ${withTools}/${results.length} findings; ${totalToolCalls} tool calls total`,
  );

  const staticKilled = results.filter((r) => r.killedByStatic === true).length;
  const known = results.filter((r) => r.killedByStatic !== undefined).length;
  if (known > 0) {
    const toolKilledStaticKept = results.filter(
      (r) => r.killedByStatic === false && r.killedByTools,
    ).length;
    const toolKeptStaticKilled = results.filter(
      (r) => r.killedByStatic === true && !r.killedByTools,
    ).length;
    console.log(`\nvs static gate (over the ${known} findings both scored):`);
    console.log(
      `  static killed ${staticKilled}, agentic killed ${results.filter((r) => r.killedByTools && r.killedByStatic !== undefined).length}`,
    );
    console.log(
      `  agentic killed but static kept: ${toolKilledStaticKept}  (refutations the static gate missed)`,
    );
    console.log(
      `  static killed but agentic kept: ${toolKeptStaticKilled}  (recall the agentic gate preserved)`,
    );
  }

  console.log(
    `\nspend: $${(spentCents / 100).toFixed(4)}  (in ${usage.inputTokens} / out ${usage.outputTokens} tokens)`,
  );
  console.log(`-> ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
