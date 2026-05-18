import { z } from 'zod';
import { getEnv } from '@/env';
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  type InlineReviewComment,
  type PullRequestFile,
  postPullRequestReview,
  type RepoCoordinates,
} from '@/github/client';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { estimateCost } from '@/lib/cost';
import { IdempotencyStore } from '@/lib/idempotency';
import { trace } from '@/lib/trace';
import { callReview } from '@/openai/review';
import type { Finding } from '@/openai/schema';

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
  comment: z.object({ id: z.number().int(), body: z.string() }),
});
export type IssueCommentPayload = z.infer<typeof IssueCommentPayload>;

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

function scheduleReview(ctx: ReviewContext): void {
  runReview(ctx).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    trace({
      event: 'review.unhandled_error',
      deliveryId: ctx.deliveryId,
      repoFullName: `${ctx.coords.owner}/${ctx.coords.repo}`,
      prNumber: ctx.prNumber,
      status: 'failed',
      error: reason,
    });
  });
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

    const result = await callReview({
      prTitle: pr.title,
      prBody: pr.body,
      files: filesWithPatch.map((f) => ({ filename: f.filename, patch: f.patch })),
      model: env.OPENAI_MODEL,
    });

    const cost = estimateCost(
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cachedInputTokens,
    );

    if (cost.totalCents > env.COST_CAP_CENTS_PER_REVIEW) {
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

    const inlineComments: InlineReviewComment[] = validFindings.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: formatFinding(f),
    }));

    const body = formatReviewBody(
      result.review.summary,
      result.review.findings.length,
      validFindings.length,
    );

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
        totalFindings: result.review.findings.length,
        postedFindings: validFindings.length,
        droppedFindings: droppedFindings.length,
        droppedFindingLocations: droppedFindings,
        filesTruncated: filesResult.truncated,
        usage: result.usage,
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
  return [header, '', f.message].join('\n');
}

function formatReviewBody(summary: string, total: number, posted: number): string {
  const dropped = total - posted;
  const lines = [summary];
  if (dropped > 0) {
    lines.push('');
    const suffix = dropped === 1 ? '' : 's';
    lines.push(`_Dropped ${dropped} finding${suffix} that referenced lines outside this PR diff._`);
  }
  return lines.join('\n');
}
