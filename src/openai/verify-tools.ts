import type OpenAI from 'openai';
import { fetchFileAtRef, fetchRepoTree, type RepoCoordinates } from '@/github/client';
import { buildVerifyUserPrompt, type PromptFile, VERIFY_TOOLS_SYSTEM_PROMPT } from './prompt';
import { client } from './review';
import type { Finding } from './schema';
import {
  decideKeep,
  type SingleVerdict,
  type VerifiedFinding,
  type VerifierUsage,
  type VerifyResult,
} from './verify';

const MAX_TOOL_ITERS_DEFAULT = 8;
const MAX_TOKENS_PER_STEP = 8000;
const MAX_READ_LINES = 200;
const MAX_FIND_RESULTS = 40;

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

// A capability the verifier can call to inspect real repository code at the PR
// head commit. Injected so the production path (GitHub API) and the offline
// eval (gh CLI) drive the exact same loop.
export interface CodeFetcher {
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
  findFiles(query: string): Promise<string[]>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: string;
}
export interface ModelStep {
  message: Msg;
  toolCalls: ParsedToolCall[];
  usage: VerifierUsage;
}
// One turn of the conversation. Injected so the loop is unit-testable with a
// scripted model rather than a live gateway call. `forceSubmit` asks the
// implementation to require a submit_verdict call this turn (used on the final
// turn to guarantee a decision).
export type CompleteFn = (messages: Msg[], opts?: { forceSubmit?: boolean }) => Promise<ModelStep>;

export const VERIFY_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'List repository file paths whose path contains the query, to locate where a helper, type, or module is defined.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A path substring or file name, e.g. "utils" or "http.js".',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read real source from a file at the pull request head commit. Use it to inspect a definition the finding depends on.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          start_line: { type: 'integer', description: 'First line to read (1-based). Optional.' },
          end_line: { type: 'integer', description: 'Last line to read, inclusive. Optional.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_verdict',
      description: 'Submit the final decision. Call exactly once, when you have enough evidence.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['real', 'false_positive'] },
          reason: { type: 'string', description: 'One sentence citing what you read.' },
        },
        required: ['verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Render a slice of a file with 1-based line numbers so the model can cite
// exact lines, bounded so one read cannot flood the context window.
export function sliceWithLineNumbers(
  content: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = content.split('\n');
  const start = Math.max(1, startLine ?? 1);
  if (start > lines.length) return `file has only ${lines.length} lines`;
  const end = Math.min(
    lines.length,
    endLine ?? start + MAX_READ_LINES - 1,
    start + MAX_READ_LINES - 1,
  );
  const out: string[] = [];
  for (let i = start; i <= end; i += 1) out.push(`${i}: ${lines[i - 1]}`);
  let res = out.join('\n');
  if (end < lines.length) res += `\n... (${lines.length - end} more lines)`;
  return res;
}

function parseVerdictArgs(
  raw: string,
): { verdict: 'real' | 'false_positive'; reason: string } | null {
  try {
    const o = JSON.parse(raw) as { verdict?: unknown; reason?: unknown };
    if (o.verdict === 'real' || o.verdict === 'false_positive') {
      return {
        verdict: o.verdict,
        reason: typeof o.reason === 'string' && o.reason.length > 0 ? o.reason : 'no reason given',
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

async function execTool(
  call: ParsedToolCall,
  fetcher: CodeFetcher,
  log: string[],
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.args) as Record<string, unknown>;
  } catch {
    return 'error: tool arguments were not valid JSON';
  }
  try {
    if (call.name === 'read_file') {
      const path = String(args.path ?? '');
      if (!path) return 'error: path is required';
      log.push(`read_file ${path}:${num(args.start_line) ?? ''}-${num(args.end_line) ?? ''}`);
      return await fetcher.readFile(path, num(args.start_line), num(args.end_line));
    }
    if (call.name === 'find_files') {
      const query = String(args.query ?? '');
      if (!query) return 'error: query is required';
      log.push(`find_files ${query}`);
      const files = await fetcher.findFiles(query);
      return files.length > 0 ? files.slice(0, MAX_FIND_RESULTS).join('\n') : 'no matching files';
    }
    return `error: unknown tool ${call.name}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Agentic verification of one finding. The model may call read_file/find_files
// to inspect the real repository before deciding, and finishes by calling
// submit_verdict. Returns a SingleVerdict, failing open to `error` on any
// failure or when the model never submits within the iteration budget, plus a
// log of the tool calls it made for tracing.
export async function verifyOneWithTools(opts: {
  finding: Finding;
  fileDiff: PromptFile[];
  fetcher: CodeFetcher;
  complete: CompleteFn;
  model: string;
  maxIters?: number;
}): Promise<{ verdict: SingleVerdict; usage: VerifierUsage; toolLog: string[] }> {
  const maxIters = opts.maxIters ?? MAX_TOOL_ITERS_DEFAULT;
  const usage: VerifierUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const toolLog: string[] = [];
  const messages: Msg[] = [
    { role: 'system', content: VERIFY_TOOLS_SYSTEM_PROMPT },
    { role: 'user', content: buildVerifyUserPrompt(opts.finding, opts.fileDiff) },
  ];

  for (let iter = 0; iter < maxIters; iter += 1) {
    // On the final allowed turn, force a submit_verdict call so a finding that
    // needed several reads still returns a verdict instead of failing open at
    // the iteration budget. Reasoning-eager models otherwise keep investigating.
    const forceSubmit = iter === maxIters - 1;
    let step: ModelStep;
    try {
      step = await opts.complete(messages, { forceSubmit });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { verdict: { model: opts.model, verdict: 'error', reason }, usage, toolLog };
    }
    usage.inputTokens += step.usage.inputTokens;
    usage.outputTokens += step.usage.outputTokens;
    usage.cachedInputTokens += step.usage.cachedInputTokens;

    if (step.toolCalls.length === 0) {
      // The model answered with prose instead of calling submit_verdict. Fail
      // open rather than try to parse a verdict out of free text.
      return {
        verdict: {
          model: opts.model,
          verdict: 'error',
          reason: 'model did not call submit_verdict',
        },
        usage,
        toolLog,
      };
    }

    messages.push(step.message);
    let submitted: SingleVerdict | undefined;
    for (const call of step.toolCalls) {
      if (call.name === 'submit_verdict') {
        const parsed = parseVerdictArgs(call.args);
        submitted = parsed
          ? { model: opts.model, verdict: parsed.verdict, reason: parsed.reason }
          : { model: opts.model, verdict: 'error', reason: 'submit_verdict had invalid arguments' };
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'recorded' });
      } else {
        const result = await execTool(call, opts.fetcher, toolLog);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    if (submitted) return { verdict: submitted, usage, toolLog };
  }

  return {
    verdict: {
      model: opts.model,
      verdict: 'error',
      reason: 'verifier exceeded tool-iteration budget',
    },
    usage,
    toolLog,
  };
}

// Wrap the shared OpenRouter-routed client as a CompleteFn. Kept separate from
// the loop so the loop can be tested with a scripted model.
export function clientComplete(model: string, maxTokens = MAX_TOKENS_PER_STEP): CompleteFn {
  return async (messages, opts) => {
    const completion = await client().chat.completions.create({
      model,
      messages,
      tools: VERIFY_TOOLS,
      tool_choice: opts?.forceSubmit
        ? { type: 'function', function: { name: 'submit_verdict' } }
        : 'auto',
      max_completion_tokens: maxTokens,
    });
    const message = (completion.choices[0]?.message ?? { role: 'assistant', content: '' }) as Msg;
    const rawCalls = completion.choices[0]?.message?.tool_calls ?? [];
    const toolCalls: ParsedToolCall[] = rawCalls
      .filter(
        (t): t is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: 'function' } =>
          t.type === 'function',
      )
      .map((t) => ({ id: t.id, name: t.function.name, args: t.function.arguments }));
    const u = completion.usage;
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
}

// A CodeFetcher backed by the GitHub API at a fixed commit, with per-review
// caches so repeated reads of the same file or tree cost one call each.
export function githubFetcher(
  installationId: number,
  coords: RepoCoordinates,
  ref: string,
): CodeFetcher {
  const fileCache = new Map<string, string | null>();
  let tree: string[] | undefined;
  return {
    async readFile(path, startLine, endLine) {
      if (!fileCache.has(path)) {
        fileCache.set(path, await fetchFileAtRef(installationId, coords, path, ref));
      }
      const content = fileCache.get(path);
      if (content == null) return `file not found at ${ref}: ${path}`;
      return sliceWithLineNumbers(content, startLine, endLine);
    },
    async findFiles(query) {
      if (!tree) tree = (await fetchRepoTree(installationId, coords, ref)).paths;
      const q = query.toLowerCase();
      return tree.filter((p) => p.toLowerCase().includes(q));
    },
  };
}

// Run each finding through the agentic verifier and keep the ones it does not
// refute. Mirrors verifyFindings (refutation-first via decideKeep, fail-open on
// errors) but with a single tool-using verifier model instead of a static
// panel.
export async function verifyFindingsWithTools(
  findings: Finding[],
  patchByFile: Map<string, string | undefined>,
  model: string,
  fetcher: CodeFetcher,
  maxIters?: number,
  // Injected only in tests. Production passes nothing and uses the shared client.
  complete: CompleteFn = clientComplete(model),
): Promise<VerifyResult & { toolLogs: string[][] }> {
  const usage: VerifierUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let errorCount = 0;
  const details: VerifiedFinding[] = [];
  const toolLogs: string[][] = [];

  for (const finding of findings) {
    const patch = patchByFile.get(finding.file);
    if (!patch) {
      details.push({
        finding,
        kept: true,
        verdicts: [{ model: '(none)', verdict: 'error', reason: 'no patch for file' }],
      });
      toolLogs.push([]);
      errorCount += 1;
      continue;
    }
    const {
      verdict,
      usage: u,
      toolLog,
    } = await verifyOneWithTools({
      finding,
      fileDiff: [{ filename: finding.file, patch }],
      fetcher,
      complete,
      model,
      maxIters,
    });
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens;
    if (verdict.verdict === 'error') errorCount += 1;
    details.push({ finding, kept: decideKeep([verdict]), verdicts: [verdict] });
    toolLogs.push(toolLog);
  }

  return {
    kept: details.filter((d) => d.kept).map((d) => d.finding),
    dropped: details.filter((d) => !d.kept).map((d) => d.finding),
    details,
    usage,
    errorCount,
    toolLogs,
  };
}
