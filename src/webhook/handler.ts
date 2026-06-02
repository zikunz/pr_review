import { z } from 'zod';
import { getEnv } from '@/env';
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  type InlineReviewComment,
  MAX_PR_FILE_PAGES,
  type PullRequestFile,
  postPullRequestReview,
  type RepoCoordinates,
} from '@/github/client';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { selectReviewModel } from '@/lib/cascade';
import { type CostBreakdown, CostCapExceededError, enforceCostCap, estimateCost } from '@/lib/cost';
import { IdempotencyStore } from '@/lib/idempotency';
import { trace } from '@/lib/trace';
import { callReview } from '@/openai/review';
import type { Finding } from '@/openai/schema';
import { verifyFindings } from '@/openai/verify';

type FileWithPatch = PullRequestFile & { patch: string };

const idempotency = new IdempotencyStore();

const ALLOWED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

export const MAX_PROMPT_DIFF_CHARS = 200_000;

const Repository = z.object({
  owner: z.object({ login: z.string().min(1) }),
  name: z.string().min(1),
});

const Installation = z.object({ id: z.number().int().positive() }).optional();

export const PullRequestPayload = z.object({
  action: z.string().min(1),
  installation: Installation,
  repository: Repository,
  pull_request: z.object({ number: z.number().int().positive() }),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export const IssueCommentPayload = z.object({
  action: z.string().min(1),
  installation: Installation,
  repository: Repository,
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string(),
    author_association: z.string().min(1),
  }),
});
export type IssueCommentPayload = z.infer<typeof IssueCommentPayload>;

// Only commenters with write access can re-trigger a review via @mention.
// Anyone with read access can comment on a public PR, so without this gate a
// drive-by attacker could burn the cost cap one review at a time by spamming
// `@<bot-name>` mentions.
const ALLOWED_COMMENT_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type DispatchResult =
  | { status: 'accepted' }
  | { status: 'ignored'; reason: string }
  | { status: 'duplicate' };

export function handlePullRequestEvent(
  payload: PullRequestPayload,
  deliveryId: string,
): DispatchResult {
  if (!ALLOWED_PR_ACTIONS.has(payload.action)) {
    return { status: 'ignored', reason: `pr action ${payload.action}` };
  }
  if (!payload.installation) {
    return { status: 'ignored', reason: 'missing installation' };
  }
  if (idempotency.has(deliveryId)) return { status: 'duplicate' };
  idempotency.remember(deliveryId);

  const ctx: ReviewContext = {
    deliveryId,
    installationId: payload.installation.id,
    coords: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    },
    prNumber: payload.pull_request.number,
    triggerEvent: `pull_request.${payload.action}`,
  };

  scheduleReview(ctx);
  return { status: 'accepted' };
}

export function handleIssueCommentEvent(
  payload: IssueCommentPayload,
  deliveryId: string,
): DispatchResult {
  if (payload.action !== 'created') {
    return { status: 'ignored', reason: `issue_comment action ${payload.action}` };
  }
  if (!payload.issue.pull_request) {
    return { status: 'ignored', reason: 'comment not on a PR' };
  }
  if (!payload.installation) {
    return { status: 'ignored', reason: 'missing installation' };
  }
  const env = getEnv();
  if (!isBotMentioned(payload.comment.body, env.GITHUB_BOT_USERNAME)) {
    return { status: 'ignored', reason: 'bot not mentioned' };
  }
  if (!ALLOWED_COMMENT_AUTHOR_ASSOCIATIONS.has(payload.comment.author_association)) {
    return {
      status: 'ignored',
      reason: `comment author association ${payload.comment.author_association}`,
    };
  }
  if (idempotency.has(deliveryId)) return { status: 'duplicate' };
  idempotency.remember(deliveryId);

  const ctx: ReviewContext = {
    deliveryId,
    installationId: payload.installation.id,
    coords: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    },
    prNumber: payload.issue.number,
    triggerEvent: 'issue_comment.mention',
  };

  scheduleReview(ctx);
  return { status: 'accepted' };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPatch(file: PullRequestFile): file is FileWithPatch {
  return typeof file.patch === 'string' && file.patch.length > 0;
}

export function isBotMentioned(body: string, botUsername: string): boolean {
  const pattern = new RegExp(
    `(?<![\\w-])@${escapeRegex(botUsername)}(?:\\[bot\\])?(?![\\w-])`,
    'i',
  );
  return pattern.test(body);
}

interface ReviewContext {
  deliveryId: string;
  installationId: number;
  coords: RepoCoordinates;
  prNumber: number;
  triggerEvent: string;
}

// Track fire-and-forget review promises so the shutdown path can wait for
// them to settle before the process exits. Without this, a SIGTERM during a
// Railway redeploy drops every in-flight review silently, leaving the
// originating PR with no bot comment.
const inFlightReviews = new Set<Promise<unknown>>();

function scheduleReview(ctx: ReviewContext): void {
  const promise: Promise<void> = runReview(ctx).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      trace({
        event: 'review.unhandled_error',
        deliveryId: ctx.deliveryId,
        repoFullName: `${ctx.coords.owner}/${ctx.coords.repo}`,
        prNumber: ctx.prNumber,
        status: 'failed',
        error: reason,
      });
    } catch {
      // Swallow trace failures (for example a stdout EPIPE during a
      // platform-driven shutdown). Surfacing them as an unhandled
      // rejection here would re-enter `shutdown` via the
      // `unhandledRejection` handler in `src/server.ts`, see
      // `shuttingDown === true`, and force-exit while other reviews are
      // still draining.
    }
  });
  inFlightReviews.add(promise);
  promise
    .finally(() => {
      inFlightReviews.delete(promise);
    })
    .catch(() => {
      // `Promise.prototype.finally` re-throws any rejection from the
      // upstream promise. The catch handler above already absorbed the
      // review error, so the only way this path triggers is if the catch
      // handler itself threw an exception that escaped its own
      // try/catch. Swallow here to keep the cleanup chain from raising
      // an unhandled rejection that would take the whole process down.
    });
}

// Resolve once every currently-scheduled review has settled. The shutdown
// path in `src/server.ts` awaits this AFTER `server.close` has resolved, so
// every request handler has already finished calling `scheduleReview` by
// the time the spread snapshot is taken. An earlier parallel-drain design
// had a race where a handler still in `await c.req.text()` at SIGTERM
// scheduled a review after the snapshot was taken. Sequential ordering
// (close the HTTP listener first, snapshot the in-flight set second)
// closes that race.
export async function drainInFlightReviews(): Promise<void> {
  await Promise.allSettled([...inFlightReviews]);
}

export function inFlightReviewCount(): number {
  return inFlightReviews.size;
}

async function runReview(ctx: ReviewContext): Promise<void> {
  const env = getEnv();
  const start = Date.now();
  const repoFullName = `${ctx.coords.owner}/${ctx.coords.repo}`;
  const baseLog = { deliveryId: ctx.deliveryId, repoFullName, prNumber: ctx.prNumber };

  trace({ event: 'review.started', ...baseLog, details: { trigger: ctx.triggerEvent } });

  try {
    const pr = await fetchPullRequest(ctx.installationId, ctx.coords, ctx.prNumber);
    if (pr.state !== 'open') {
      trace({
        event: 'review.skipped',
        ...baseLog,
        status: 'skipped',
        details: { reason: 'pr not open', state: pr.state },
      });
      return;
    }

    const filesResult = await fetchPullRequestFiles(ctx.installationId, ctx.coords, ctx.prNumber);
    const filesWithPatch = filesResult.files.filter(hasPatch);
    if (filesWithPatch.length === 0) {
      trace({
        event: 'review.skipped',
        ...baseLog,
        status: 'skipped',
        details: { reason: 'no textual diff', filesTruncated: filesResult.truncated },
      });
      return;
    }

    const totalPatchChars = filesWithPatch.reduce((sum, f) => sum + f.patch.length, 0);
    if (totalPatchChars > MAX_PROMPT_DIFF_CHARS) {
      trace({
        event: 'review.skipped',
        ...baseLog,
        status: 'skipped',
        details: {
          reason: 'diff exceeds prompt size cap',
          totalPatchChars,
          capChars: MAX_PROMPT_DIFF_CHARS,
          filesTruncated: filesResult.truncated,
        },
      });
      return;
    }

    const validLocations = parseDiffLocations(
      filesWithPatch.map((f) => ({ path: f.filename, patch: f.patch })),
    );

    // v0.2 cascade routing. When CASCADE_ENABLED the tier is chosen from diff
    // signals; otherwise OPENAI_MODEL is used as a single flat model. The
    // selection logic lives in selectReviewModel (pure, unit-tested).
    const { model: modelForReview, cascade: cascadeDecision } = selectReviewModel(
      env.CASCADE_ENABLED,
      env.OPENAI_MODEL,
      filesWithPatch.map((f) => ({ filename: f.filename, patch: f.patch })),
      {
        tier1Model: env.CASCADE_TIER1_MODEL,
        tier2Model: env.CASCADE_TIER2_MODEL,
        tier3Model: env.CASCADE_TIER3_MODEL,
        tier2MaxChars: env.CASCADE_TIER2_MAX_CHARS,
      },
    );

    const result = await callReview({
      prTitle: pr.title,
      prBody: pr.body,
      files: filesWithPatch.map((f) => ({ filename: f.filename, patch: f.patch })),
      model: modelForReview,
    });

    let cost: CostBreakdown;
    try {
      cost = estimateCost(
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cachedInputTokens,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace({
        event: 'review.pricing_missing',
        ...baseLog,
        status: 'failed',
        model: result.model,
        durationMs: Date.now() - start,
        error: reason,
        details: { usage: result.usage },
      });
      return;
    }

    try {
      enforceCostCap(cost.totalCents, env.COST_CAP_CENTS_PER_REVIEW);
    } catch (err) {
      if (!(err instanceof CostCapExceededError)) throw err;
      trace({
        event: 'review.cost_cap_exceeded',
        ...baseLog,
        status: 'skipped',
        costCents: cost.totalCents,
        model: result.model,
        durationMs: Date.now() - start,
        details: { capCents: env.COST_CAP_CENTS_PER_REVIEW, usage: result.usage },
      });
      return;
    }

    const validFindings: Finding[] = [];
    const droppedFindings: Array<{ file: string; line: number }> = [];
    for (const f of result.review.findings) {
      if (isValidCommentLocation(validLocations, f.file, f.line)) {
        validFindings.push(f);
      } else {
        droppedFindings.push({ file: f.file, line: f.line });
      }
    }

    // v0.3 verification gate (opt-in via VERIFY_ENABLED). Each finding that
    // passed the diff-anchor gate is audited against its file's diff; a finding
    // is dropped only when the verifier panel unanimously refutes it. Off by
    // default, so this stays a no-op until an operator enables it.
    let findingsToPost = validFindings;
    let verification:
      | {
          models: string[];
          kept: number;
          dropped: number;
          errors: number;
          usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
          cents?: number;
        }
      | undefined;
    if (env.VERIFY_ENABLED && validFindings.length > 0) {
      const patchByFile = new Map(filesWithPatch.map((f) => [f.filename, f.patch]));
      const verified = await verifyFindings(validFindings, patchByFile, env.VERIFY_MODELS);
      findingsToPost = verified.kept;
      let cents: number | undefined;
      try {
        // Exact for the single-model default; approximate (rated at the first
        // model's price) when several verifier models run.
        cents = estimateCost(
          env.VERIFY_MODELS[0] ?? result.model,
          verified.usage.inputTokens,
          verified.usage.outputTokens,
          verified.usage.cachedInputTokens,
        ).totalCents;
      } catch {
        // Verifier model has no pricing entry; usage is still traced below.
      }
      verification = {
        models: env.VERIFY_MODELS,
        kept: verified.kept.length,
        dropped: verified.dropped.length,
        errors: verified.errorCount,
        usage: verified.usage,
        cents,
      };
    }

    const inlineComments: InlineReviewComment[] = findingsToPost.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: formatFinding(f),
    }));

    const body = formatReviewBody(
      result.review.summary,
      result.review.findings.length,
      validFindings.length,
      filesResult.truncated,
    );

    // `event: 'COMMENT'` is hard-coded by design. The model still emits
    // `result.review.overall_assessment` per the Zod schema, but the
    // handler intentionally ignores it. The ROADMAP non-goal section
    // forbids automatic PR approval, so even an `approve` from the
    // model would never translate into a state-changing review event.
    // The field stays in the schema as forward-compatibility for v0.2
    // routing decisions that may consult model confidence. v0.1 only
    // ever comments.
    await postPullRequestReview(ctx.installationId, ctx.coords, ctx.prNumber, {
      body,
      event: 'COMMENT',
      comments: inlineComments,
      commitId: pr.head.sha,
    });

    trace({
      event: 'review.posted',
      ...baseLog,
      status: 'ok',
      costCents: cost.totalCents,
      model: result.model,
      durationMs: Date.now() - start,
      details: {
        trigger: ctx.triggerEvent,
        cascade: cascadeDecision
          ? {
              tier: cascadeDecision.tier,
              model: cascadeDecision.model,
              reason: cascadeDecision.reason,
            }
          : null,
        totalFindings: result.review.findings.length,
        postedFindings: findingsToPost.length,
        droppedFindings: droppedFindings.length,
        droppedFindingLocations: droppedFindings,
        filesTruncated: filesResult.truncated,
        usage: result.usage,
        verification,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    trace({
      event: 'review.failed',
      ...baseLog,
      status: 'failed',
      durationMs: Date.now() - start,
      error: reason,
    });
  }
}

function formatFinding(f: Finding): string {
  const header = `**[${f.severity.toUpperCase()} | ${f.category}]** confidence ${f.confidence.toFixed(2)}`;
  // The model controls f.message. Convert HTML-significant characters so a
  // crafted finding cannot inject markup, and escape the brackets that start
  // a Markdown link so the model cannot phish the reader with
  // `[click here](evil.com)` style payloads. Backticks are deliberately not
  // escaped: GitHub PR comments render `\\\`` as a literal backslash, which
  // breaks inline code rendering, and inline code spans are a constrained
  // construct that cannot embed images, links, or scripts on their own.
  const safeMessage = f.message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  return [header, '', safeMessage].join('\n');
}

function formatReviewBody(
  summary: string,
  total: number,
  posted: number,
  filesTruncated: boolean,
): string {
  // The model controls `summary` the same way it controls each finding's
  // message, so apply the same escape chain `formatFinding` uses. Without
  // this, a prompt-injected PR description can elicit a model summary
  // containing a Markdown link or image and the bot posts it under its own
  // identity.
  const safeSummary = summary
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  const dropped = total - posted;
  const lines = [safeSummary];
  if (dropped > 0) {
    lines.push('');
    const suffix = dropped === 1 ? '' : 's';
    lines.push(`_Dropped ${dropped} finding${suffix} that referenced lines outside this PR diff._`);
  }
  if (filesTruncated) {
    // Format with thousands separator so the rendered review body matches
    // the "3,000" form used in README Limitations and ROADMAP Risks.
    const fileLimit = (MAX_PR_FILE_PAGES * 100).toLocaleString('en-US');
    lines.push('');
    lines.push(
      `_This PR exceeded the bot's per-review file budget. The bot reviewed only the first ${fileLimit} changed files. Later files were not inspected._`,
    );
  }
  return lines.join('\n');
}
