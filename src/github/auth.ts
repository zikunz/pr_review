import { importPKCS8, SignJWT } from 'jose';
import { getEnv } from '@/env';

let cachedPrivateKey: CryptoKey | undefined;
const installationTokenCache = new Map<number, { token: string; expiresAtMs: number }>();

async function loadPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const env = getEnv();
  cachedPrivateKey = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, 'RS256');
  return cachedPrivateKey;
}

async function createAppJwt(): Promise<string> {
  const env = getEnv();
  const privateKey = await loadPrivateKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + 600)
    .sign(privateKey);
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const now = Date.now();
  const cached = installationTokenCache.get(installationId);
  if (cached && now < cached.expiresAtMs - 60_000) {
    return cached.token;
  }

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
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Installation token exchange failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as InstallationTokenResponse;
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAtMs: new Date(data.expires_at).getTime(),
  });
  return data.token;
}
