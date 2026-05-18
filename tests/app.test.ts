import { beforeAll, describe, expect, it } from 'vitest';

const TEST_SECRET = "It's a Secret to Everybody";
const TEST_BODY = 'Hello, World!';
const TEST_VALID_SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

let app: typeof import('@/app').app;

beforeAll(async () => {
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
${'A'.repeat(200)}
-----END PRIVATE KEY-----`;
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-key-for-routing-tests-only';

  const mod = await import('@/app');
  app = mod.app;
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.fetch(new Request('http://local/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /github/webhook', () => {
  it('rejects request without a signature header', async () => {
    const res = await app.fetch(
      new Request('http://local/github/webhook', {
        method: 'POST',
        body: TEST_BODY,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects request with a tampered signature', async () => {
    const res = await app.fetch(
      new Request('http://local/github/webhook', {
        method: 'POST',
        body: TEST_BODY,
        headers: { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects request when delivery id header is missing', async () => {
    const res = await app.fetch(
      new Request('http://local/github/webhook', {
        method: 'POST',
        body: TEST_BODY,
        headers: { 'X-Hub-Signature-256': TEST_VALID_SIG },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 ignored for unknown event types with valid signature', async () => {
    const res = await app.fetch(
      new Request('http://local/github/webhook', {
        method: 'POST',
        body: TEST_BODY,
        headers: {
          'X-Hub-Signature-256': TEST_VALID_SIG,
          'X-GitHub-Event': 'ping',
          'X-GitHub-Delivery': 'test-delivery-id-1',
        },
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('ignored');
  });

  it('rejects body that is not valid JSON', async () => {
    const sig = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    const res = await app.fetch(
      new Request('http://local/github/webhook', {
        method: 'POST',
        body: TEST_BODY,
        headers: {
          'X-Hub-Signature-256': sig,
          'X-GitHub-Event': 'pull_request',
          'X-GitHub-Delivery': 'test-delivery-json-fail',
        },
      }),
    );
    expect(res.status).toBe(400);
  });
});
