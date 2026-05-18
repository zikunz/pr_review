import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from '@/webhook/verify';

const SECRET = "It's a Secret to Everybody";
const PAYLOAD = 'Hello, World!';
const VALID_SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe('verifyGitHubSignature', () => {
  it('accepts the GitHub documented test vector', async () => {
    const result = await verifyGitHubSignature(PAYLOAD, VALID_SIG, SECRET);
    expect(result).toBe(true);
  });

  it('rejects an entirely wrong signature', async () => {
    const wrong = `sha256=${'0'.repeat(64)}`;
    const result = await verifyGitHubSignature(PAYLOAD, wrong, SECRET);
    expect(result).toBe(false);
  });

  it('rejects when the secret is wrong', async () => {
    const result = await verifyGitHubSignature(PAYLOAD, VALID_SIG, 'wrong secret');
    expect(result).toBe(false);
  });

  it('rejects when the body is tampered with', async () => {
    const result = await verifyGitHubSignature('Hello, World?', VALID_SIG, SECRET);
    expect(result).toBe(false);
  });

  it('rejects null signature header', async () => {
    const result = await verifyGitHubSignature(PAYLOAD, null, SECRET);
    expect(result).toBe(false);
  });

  it('rejects signature without sha256= prefix', async () => {
    const result = await verifyGitHubSignature(PAYLOAD, 'invalid', SECRET);
    expect(result).toBe(false);
  });

  it('rejects signature with wrong length after prefix', async () => {
    const result = await verifyGitHubSignature(PAYLOAD, 'sha256=abc', SECRET);
    expect(result).toBe(false);
  });
});
