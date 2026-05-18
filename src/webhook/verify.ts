import { createHmac, timingSafeEqual } from 'node:crypto';

export async function verifyGitHubSignature(
  body: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const providedHex = signatureHeader.slice(expectedPrefix.length);
  if (providedHex.length !== 64 || !/^[0-9a-f]+$/i.test(providedHex)) return false;

  const computedHex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  const providedBuf = Buffer.from(providedHex, 'hex');
  const computedBuf = Buffer.from(computedHex, 'hex');
  if (providedBuf.length !== computedBuf.length) return false;

  return timingSafeEqual(providedBuf, computedBuf);
}
