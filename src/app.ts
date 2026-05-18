import { Hono } from 'hono';
import { getEnv } from '@/env';
import {
  handleIssueCommentEvent,
  handlePullRequestEvent,
  IssueCommentPayload,
  PullRequestPayload,
} from '@/webhook/handler';
import { verifyGitHubSignature } from '@/webhook/verify';

export const app = new Hono();

// GitHub documents an outer webhook payload size limit of 25 MiB; refuse anything
// larger before allocating memory or running HMAC over attacker controlled bytes.
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/github/webhook', async (c) => {
  const env = getEnv();

  const contentLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.text('payload too large', 413);
  }

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.text('failed to read request body', 400);
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    return c.text('payload too large', 413);
  }

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

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return c.text('invalid json body', 400);
  }

  if (event === 'pull_request') {
    const parsed = PullRequestPayload.safeParse(rawPayload);
    if (!parsed.success) {
      return c.json({ status: 'ignored', reason: 'payload shape rejected' }, 200);
    }
    const result = handlePullRequestEvent(parsed.data, deliveryId);
    return result.status === 'accepted' ? c.json(result, 202) : c.json(result, 200);
  }

  const parsed = IssueCommentPayload.safeParse(rawPayload);
  if (!parsed.success) {
    return c.json({ status: 'ignored', reason: 'payload shape rejected' }, 200);
  }
  const result = handleIssueCommentEvent(parsed.data, deliveryId);
  return result.status === 'accepted' ? c.json(result, 202) : c.json(result, 200);
});
