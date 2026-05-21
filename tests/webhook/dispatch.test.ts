import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  drainInFlightReviews,
  handleIssueCommentEvent,
  handlePullRequestEvent,
  inFlightReviewCount,
} from '@/webhook/handler';

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'GITHUB_BOT_USERNAME',
] as const;
const envSnapshot = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key]);
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
${'A'.repeat(200)}
-----END PRIVATE KEY-----`;
  process.env.GITHUB_WEBHOOK_SECRET = 'dispatch-test-secret-32-characters-long';
  process.env.OPENAI_API_KEY = 'sk-test-dispatch-routing-only';
  process.env.GITHUB_BOT_USERNAME = 'pr-cascade-bot';
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const original = envSnapshot.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function basePr(action: string, prNumber: number) {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: 'octo' }, name: 'demo' },
    pull_request: { number: prNumber },
  };
}

function baseComment(
  action: string,
  body: string,
  opts?: { onPr?: boolean; authorAssociation?: string },
) {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: 'octo' }, name: 'demo' },
    issue: {
      number: 7,
      ...(opts?.onPr === false ? {} : { pull_request: { url: 'x' } }),
    },
    comment: {
      id: 100,
      body,
      author_association: opts?.authorAssociation ?? 'OWNER',
    },
  };
}

describe('handlePullRequestEvent', () => {
  it('accepts an opened action with an installation', () => {
    const result = handlePullRequestEvent(basePr('opened', 1001), 'd-1001');
    expect(result).toEqual({ status: 'accepted' });
  });

  it('ignores actions outside the allowlist with a reason that names the action', () => {
    const result = handlePullRequestEvent(basePr('edited', 1002), 'd-1002');
    expect(result).toEqual({ status: 'ignored', reason: 'pr action edited' });
  });

  it('ignores when installation is missing with an explanatory reason', () => {
    const payload = { ...basePr('opened', 1003), installation: undefined };
    const result = handlePullRequestEvent(payload, 'd-1003');
    expect(result).toEqual({ status: 'ignored', reason: 'missing installation' });
  });

  it('treats a repeated delivery id as a duplicate', () => {
    const id = 'd-duplicate';
    handlePullRequestEvent(basePr('opened', 1004), id);
    const second = handlePullRequestEvent(basePr('opened', 1004), id);
    expect(second.status).toBe('duplicate');
  });
});

describe('handleIssueCommentEvent', () => {
  it('accepts a created comment that mentions the bot on a PR', () => {
    const payload = baseComment('created', 'please @pr-cascade-bot take another look');
    const result = handleIssueCommentEvent(payload, 'd-ic-1');
    expect(result).toEqual({ status: 'accepted' });
  });

  it('ignores comments on non-PR issues with the correct reason', () => {
    const payload = baseComment('created', '@pr-cascade-bot ?', { onPr: false });
    const result = handleIssueCommentEvent(payload, 'd-ic-2');
    expect(result).toEqual({ status: 'ignored', reason: 'comment not on a PR' });
  });

  it('ignores comments that do not mention the bot with the correct reason', () => {
    const payload = baseComment('created', 'looks good to me');
    const result = handleIssueCommentEvent(payload, 'd-ic-3');
    expect(result).toEqual({ status: 'ignored', reason: 'bot not mentioned' });
  });

  it('ignores edits even with a mention with a reason that names the action', () => {
    const payload = baseComment('edited', '@pr-cascade-bot please');
    const result = handleIssueCommentEvent(payload, 'd-ic-4');
    expect(result).toEqual({ status: 'ignored', reason: 'issue_comment action edited' });
  });

  it('treats a repeated delivery id on the mention path as duplicate', () => {
    const payload = baseComment('created', '@pr-cascade-bot dup');
    const id = 'd-ic-duplicate';
    handleIssueCommentEvent(payload, id);
    expect(handleIssueCommentEvent(payload, id).status).toBe('duplicate');
  });

  it('ignores a mention from a commenter without write access', () => {
    const payload = baseComment('created', '@pr-cascade-bot please', {
      authorAssociation: 'NONE',
    });
    const result = handleIssueCommentEvent(payload, 'd-ic-author-none');
    expect(result).toEqual({
      status: 'ignored',
      reason: 'comment author association NONE',
    });
  });

  it('accepts a mention from a collaborator', () => {
    const payload = baseComment('created', '@pr-cascade-bot please', {
      authorAssociation: 'COLLABORATOR',
    });
    const result = handleIssueCommentEvent(payload, 'd-ic-author-collab');
    expect(result).toEqual({ status: 'accepted' });
  });

  it('accepts a mention from a member of the owning org', () => {
    const payload = baseComment('created', '@pr-cascade-bot please', {
      authorAssociation: 'MEMBER',
    });
    const result = handleIssueCommentEvent(payload, 'd-ic-author-member');
    expect(result).toEqual({ status: 'accepted' });
  });
});

describe('drainInFlightReviews', () => {
  it('is callable on an empty set and resolves cleanly', async () => {
    // First clear any reviews prior tests scheduled, then assert a
    // second drain on the now-empty set still resolves and leaves
    // the counter at zero. This pins the idempotency contract of the
    // drain function independent of test ordering.
    await drainInFlightReviews();
    await drainInFlightReviews();
    expect(inFlightReviewCount()).toBe(0);
  });

  it('waits for an accepted review to settle before resolving', async () => {
    handlePullRequestEvent(basePr('opened', 9001), 'd-drain-1');
    expect(inFlightReviewCount()).toBeGreaterThan(0);
    await drainInFlightReviews();
    expect(inFlightReviewCount()).toBe(0);
  });
});
