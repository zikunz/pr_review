import { beforeAll, describe, expect, it } from 'vitest';
import { handleIssueCommentEvent, handlePullRequestEvent } from '@/webhook/handler';

beforeAll(() => {
  process.env.GITHUB_APP_ID ??= '12345';
  process.env.GITHUB_APP_PRIVATE_KEY ??= `-----BEGIN PRIVATE KEY-----
${'A'.repeat(200)}
-----END PRIVATE KEY-----`;
  process.env.GITHUB_WEBHOOK_SECRET ??= 'dispatch-test-secret-32-characters-long';
  process.env.OPENAI_API_KEY ??= 'sk-test-dispatch-routing-only';
  process.env.GITHUB_BOT_USERNAME = 'pr-cascade-bot';
});

function basePr(action: string, prNumber: number) {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: 'octo' }, name: 'demo' },
    pull_request: { number: prNumber },
  };
}

function baseComment(action: string, body: string, opts?: { onPr?: boolean }) {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: 'octo' }, name: 'demo' },
    issue: {
      number: 7,
      ...(opts?.onPr === false ? {} : { pull_request: { url: 'x' } }),
    },
    comment: { id: 100, body },
  };
}

describe('handlePullRequestEvent', () => {
  it('accepts an opened action with an installation', () => {
    const result = handlePullRequestEvent(basePr('opened', 1001), 'd-1001');
    expect(result).toEqual({ status: 'accepted' });
  });

  it('ignores actions outside the allowlist', () => {
    const result = handlePullRequestEvent(basePr('edited', 1002), 'd-1002');
    expect(result.status).toBe('ignored');
  });

  it('ignores when installation is missing', () => {
    const payload = { ...basePr('opened', 1003), installation: undefined };
    const result = handlePullRequestEvent(payload, 'd-1003');
    expect(result.status).toBe('ignored');
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

  it('ignores comments on non-PR issues', () => {
    const payload = baseComment('created', '@pr-cascade-bot ?', { onPr: false });
    const result = handleIssueCommentEvent(payload, 'd-ic-2');
    expect(result.status).toBe('ignored');
  });

  it('ignores comments that do not mention the bot', () => {
    const payload = baseComment('created', 'looks good to me');
    const result = handleIssueCommentEvent(payload, 'd-ic-3');
    expect(result.status).toBe('ignored');
  });

  it('ignores edits even with a mention', () => {
    const payload = baseComment('edited', '@pr-cascade-bot please');
    const result = handleIssueCommentEvent(payload, 'd-ic-4');
    expect(result.status).toBe('ignored');
  });
});
