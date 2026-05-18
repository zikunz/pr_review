import { getInstallationToken } from './auth';

const GITHUB_API = 'https://api.github.com';

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
    { headers: authHeaders(token) },
  );
  await expectOk(response, 'fetchPullRequest');
  return (await response.json()) as PullRequestSummary;
}

export async function fetchPullRequestFiles(
  installationId: number,
  coords: RepoCoordinates,
  pullNumber: number,
): Promise<PullRequestFile[]> {
  const token = await getInstallationToken(installationId);
  const all: PullRequestFile[] = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      { headers: authHeaders(token) },
    );
    await expectOk(response, 'fetchPullRequestFiles');
    const batch = (await response.json()) as PullRequestFile[];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 30) break;
  }
  return all;
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
    },
  );
  await expectOk(response, 'postIssueComment');
}
