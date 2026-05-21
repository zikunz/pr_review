import { getInstallationToken } from './auth';

const GITHUB_API = 'https://api.github.com';
// Outbound calls to GitHub get a hard timeout so a stuck connection cannot
// hold a review pipeline open forever.
const FETCH_TIMEOUT_MS = 30_000;
// Stop accumulating patch content once the buffer exceeds this. The
// downstream handler rejects the review when total patch chars exceeds
// `MAX_PROMPT_DIFF_CHARS = 200_000` anyway, but that check happens AFTER
// `fetchPullRequestFiles` returns the whole array. Without an inline cap
// here, a crafted PR with 3000 files at GitHub's ~3MB-per-patch limit
// could push the buffer past 9 GB before the handler ever sees it. The
// 1 MB ceiling gives the handler enough headroom to still recognise the
// "exceeds prompt size cap" case (since 1 MB > 200 KB) while bounding
// memory under adversarial PRs.
const MAX_PATCH_BUFFER_CHARS = 1_000_000;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pr-cascade',
  };
}

async function expectOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  await response.text().catch(() => '');
  throw new Error(`${context} failed: ${response.status} ${response.statusText}`);
}

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export async function fetchPullRequest(
  installationId: number,
  coords: RepoCoordinates,
  pullNumber: number,
): Promise<PullRequestSummary> {
  const token = await getInstallationToken(installationId);
  const response = await fetch(
    `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/pulls/${pullNumber}`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  await expectOk(response, 'fetchPullRequest');
  return (await response.json()) as PullRequestSummary;
}

export const MAX_PR_FILE_PAGES = 30;

export interface PullRequestFilesResult {
  files: PullRequestFile[];
  truncated: boolean;
}

export async function fetchPullRequestFiles(
  installationId: number,
  coords: RepoCoordinates,
  pullNumber: number,
): Promise<PullRequestFilesResult> {
  const token = await getInstallationToken(installationId);
  const all: PullRequestFile[] = [];
  let page = 1;
  let truncated = false;
  let cumulativePatchChars = 0;
  while (true) {
    const response = await fetch(
      `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      { headers: authHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    await expectOk(response, 'fetchPullRequestFiles');
    const batch = (await response.json()) as PullRequestFile[];
    all.push(...batch);
    for (const f of batch) {
      if (typeof f.patch === 'string') cumulativePatchChars += f.patch.length;
    }
    if (cumulativePatchChars > MAX_PATCH_BUFFER_CHARS) {
      truncated = true;
      break;
    }
    if (batch.length < 100) break;
    page++;
    if (page > MAX_PR_FILE_PAGES) {
      truncated = true;
      break;
    }
  }
  return { files: all, truncated };
}

export interface InlineReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface ReviewSubmission {
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  comments: InlineReviewComment[];
  commitId?: string;
}

export interface ReviewResponse {
  id: number;
  html_url: string;
}

export async function postPullRequestReview(
  installationId: number,
  coords: RepoCoordinates,
  pullNumber: number,
  submission: ReviewSubmission,
): Promise<ReviewResponse> {
  const token = await getInstallationToken(installationId);
  const payload: Record<string, unknown> = {
    body: submission.body,
    event: submission.event,
    comments: submission.comments,
  };
  if (submission.commitId) payload.commit_id = submission.commitId;

  const response = await fetch(
    `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/pulls/${pullNumber}/reviews`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  await expectOk(response, 'postPullRequestReview');
  return (await response.json()) as ReviewResponse;
}

export async function postIssueComment(
  installationId: number,
  coords: RepoCoordinates,
  issueNumber: number,
  body: string,
): Promise<void> {
  const token = await getInstallationToken(installationId);
  const response = await fetch(
    `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  await expectOk(response, 'postIssueComment');
}
