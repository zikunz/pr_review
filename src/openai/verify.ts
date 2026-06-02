import { zodResponseFormat } from 'openai/helpers/zod';
import { buildVerifyUserPrompt, type PromptFile, VERIFY_SYSTEM_PROMPT } from './prompt';
import { client } from './review';
import { type Finding, Verdict } from './schema';

// Same generous ceiling the offline eval used. Reasoning-capable verifier
// models spend hidden tokens before emitting the tiny JSON verdict, and a
// 4000-token cap truncated them mid-reasoning. The verdict payload itself is a
// few dozen tokens. This only buys headroom for the reasoning.
const VERIFY_MAX_COMPLETION_TOKENS = 16_000;

export interface VerifierUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface SingleVerdict {
  model: string;
  // The model returns `real` or `false_positive`. `error` is set by this module
  // when a verifier call fails or returns no parsed payload.
  verdict: 'real' | 'false_positive' | 'error';
  reason: string;
}

export interface VerifiedFinding {
  finding: Finding;
  kept: boolean;
  verdicts: SingleVerdict[];
}

export interface VerifyResult {
  kept: Finding[];
  dropped: Finding[];
  details: VerifiedFinding[];
  usage: VerifierUsage;
  errorCount: number;
}

// Refutation-first consensus. A finding is dropped only when every verifier
// explicitly returns `false_positive`. A single `real`, an `error` (a verifier
// call that failed), or a split panel all keep the finding. This reproduces the
// offline eval's removal rule (a finding was removed only when both verifiers
// said false_positive) while failing open. An infrastructure failure or a
// disagreement never silently suppresses a finding that might be a real bug.
// With no verdicts at all the gate is a no-op and the finding is kept.
export function decideKeep(verdicts: SingleVerdict[]): boolean {
  if (verdicts.length === 0) return true;
  return !verdicts.every((v) => v.verdict === 'false_positive');
}

async function verifyOne(
  model: string,
  finding: Finding,
  fileDiff: PromptFile[],
): Promise<{ verdict: SingleVerdict; usage: VerifierUsage }> {
  const empty: VerifierUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  try {
    const completion = await client().chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: VERIFY_SYSTEM_PROMPT },
        { role: 'user', content: buildVerifyUserPrompt(finding, fileDiff) },
      ],
      response_format: zodResponseFormat(Verdict, 'verdict'),
      max_completion_tokens: VERIFY_MAX_COMPLETION_TOKENS,
    });
    const u = completion.usage;
    const usage: VerifierUsage = {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      return { verdict: { model, verdict: 'error', reason: 'no parsed verdict' }, usage };
    }
    return { verdict: { model, verdict: parsed.verdict, reason: parsed.reason }, usage };
  } catch (err) {
    // Any failure (network, timeout, truncation, gateway 4xx/5xx) becomes an
    // `error` verdict, which fails open in `decideKeep`.
    const reason = err instanceof Error ? err.message : String(err);
    return { verdict: { model, verdict: 'error', reason }, usage: empty };
  }
}

// Run each finding through every verifier model and keep the ones the panel
// does not unanimously refute. Verifiers run sequentially because reviews are already
// fire-and-forget background work, so latency is not user-facing, and running
// several gateway calls at once was observed to trigger connection resets.
export async function verifyFindings(
  findings: Finding[],
  patchByFile: Map<string, string>,
  models: string[],
): Promise<VerifyResult> {
  const usage: VerifierUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let errorCount = 0;
  const details: VerifiedFinding[] = [];

  for (const finding of findings) {
    const patch = patchByFile.get(finding.file);
    if (!patch) {
      // The finding passed the diff-anchor gate, so its file normally has a
      // patch. If it somehow does not, fail open rather than judge it against
      // an empty diff the verifier would reflexively refute.
      details.push({
        finding,
        kept: true,
        verdicts: [{ model: '(none)', verdict: 'error', reason: 'no patch for file' }],
      });
      errorCount += 1;
      continue;
    }

    const fileDiff: PromptFile[] = [{ filename: finding.file, patch }];
    const verdicts: SingleVerdict[] = [];
    for (const model of models) {
      const { verdict, usage: u } = await verifyOne(model, finding, fileDiff);
      verdicts.push(verdict);
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.cachedInputTokens += u.cachedInputTokens;
      if (verdict.verdict === 'error') errorCount += 1;
    }
    details.push({ finding, kept: decideKeep(verdicts), verdicts });
  }

  return {
    kept: details.filter((d) => d.kept).map((d) => d.finding),
    dropped: details.filter((d) => !d.kept).map((d) => d.finding),
    details,
    usage,
    errorCount,
  };
}
