import { Hono } from 'hono';
import { getEnv } from '@/env';
import {
  handleIssueCommentEvent,
  handlePullRequestEvent,
  type IssueCommentPayload,
  type PullRequestPayload,
} from '@/webhook/handler';
import { verifyGitHubSignature } from '@/webhook/verify';

export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/github/webhook', async (c) => {
  const env = getEnv();
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256') ?? null;

  const signatureValid = await verifyGitHubSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!signatureValid) {
    return c.text('invalid signature', 401);
  }

  const event = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery');
  if (!deliveryId) {
    return c.text('missing X-GitHub-Delivery header', 400);
  }

  if (event !== 'pull_request' && event !== 'issue_comment') {
    return c.json({ status: 'ignored', reason: `event ${event ?? 'unknown'}` }, 200);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.text('invalid json body', 400);
  }

  if (event === 'pull_request') {
    const result = handlePullRequestEvent(payload as PullRequestPayload, deliveryId);
    return result.status === 'accepted' ? c.json(result, 202) : c.json(result, 200);
  }
  const result = handleIssueCommentEvent(payload as IssueCommentPayload, deliveryId);
  return result.status === 'accepted' ? c.json(result, 202) : c.json(result, 200);
});
