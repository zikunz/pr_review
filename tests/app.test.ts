import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_SECRET = 'It-is-a-Secret-To-Everybody-32-chars';
const TEST_BODY = 'Hello, World!';
const TEST_VALID_SIG = 'sha256=9ac3d27370518ab567c1a1f3cb87ea39937352cb016e5deb6aed19e59b5b9d2d';

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
] as const;
const envSnapshot = new Map<string, string | undefined>();

let app: typeof import('@/app').app;

beforeAll(async () => {
  for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key]);

  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
${'A'.repeat(200)}
-----END PRIVATE KEY-----`;
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-key-for-routing-tests-only';

  const mod = await import('@/app');
  app = mod.app;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const original = envSnapshot.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
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
    const sig = 'sha256=9ac3d27370518ab567c1a1f3cb87ea39937352cb016e5deb6aed19e59b5b9d2d';
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
