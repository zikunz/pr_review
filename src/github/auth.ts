import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { getEnv } from '@/env';

// Outbound calls to GitHub get a hard timeout. Without this a hung connection
// would pin a KeyObject, a fetch promise, and an inflight-coalescer entry for
// the lifetime of the container.
const FETCH_TIMEOUT_MS = 30_000;

let cachedPrivateKey: KeyObject | undefined;
const installationTokenCache = new Map<number, { token: string; expiresAtMs: number }>();
const installationTokenInflight = new Map<number, Promise<string>>();

function loadPrivateKey(): KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;
  const env = getEnv();
  // node:crypto.createPrivateKey auto-detects both PKCS#1
  // (`-----BEGIN RSA PRIVATE KEY-----`) and PKCS#8
  // (`-----BEGIN PRIVATE KEY-----`). GitHub Apps download keys in PKCS#1 by
  // default. jose.SignJWT accepts a KeyObject directly via its KeyLike type,
  // so no further conversion is needed.
  cachedPrivateKey = createPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  return cachedPrivateKey;
}

async function createAppJwt(): Promise<string> {
  const env = getEnv();
  const privateKey = loadPrivateKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + 540)
    .sign(privateKey);
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

async function mintInstallationToken(installationId: number): Promise<string> {
  const jwt = await createAppJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pr-cascade',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    await response.text().catch(() => '');
    throw new Error(
      `Installation token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as InstallationTokenResponse;
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAtMs: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const now = Date.now();
  const cached = installationTokenCache.get(installationId);
  if (cached && now < cached.expiresAtMs - 60_000) {
    return cached.token;
  }

  // Coalesce concurrent callers onto a single mint request. Without this, two
  // simultaneous webhooks for the same installation would both POST to
  // /access_tokens; GitHub revokes the older token, leaving any in-flight
  // request that used it to 401.
  const existing = installationTokenInflight.get(installationId);
  if (existing) return existing;

  const mint = mintInstallationToken(installationId).finally(() => {
    installationTokenInflight.delete(installationId);
  });
  installationTokenInflight.set(installationId, mint);
  return mint;
}
