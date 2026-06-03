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

// Reject a file the agentic verifier asks for once it is larger than this, so
// one read cannot pull a multi-megabyte minified bundle into the prompt.
const MAX_READ_FILE_BYTES = 512 * 1024;

// Fetch one file's text at a specific commit so the agentic verification gate
// can inspect a definition that lives outside the diff. Returns null when the
// path does not exist at that ref (a 404) or is not a regular file, which the
// caller surfaces to the model as "file not found" rather than failing.
export async function fetchFileAtRef(
  installationId: number,
  coords: RepoCoordinates,
  path: string,
  ref: string,
): Promise<string | null> {
  const token = await getInstallationToken(installationId);
  const encodedPath = path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const response = await fetch(
    `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (response.status === 404) return null;
  await expectOk(response, 'fetchFileAtRef');
  const data = (await response.json()) as {
    content?: string;
    encoding?: string;
    size?: number;
    type?: string;
  };
  if (data.type !== 'file' || typeof data.content !== 'string') return null;
  if ((data.size ?? 0) > MAX_READ_FILE_BYTES) {
    return `[file omitted: ${data.size} bytes exceeds the ${MAX_READ_FILE_BYTES}-byte read limit]`;
  }
  return Buffer.from(data.content, 'base64').toString('utf8');
}

export interface RepoTree {
  paths: string[];
  truncated: boolean;
}

// List the repository's file paths at a commit so the verifier can locate where
// a helper or module is defined before reading it. GitHub flags `truncated` for
// very large trees; the caller passes that on to the model.
export async function fetchRepoTree(
  installationId: number,
  coords: RepoCoordinates,
  ref: string,
): Promise<RepoTree> {
  const token = await getInstallationToken(installationId);
  const response = await fetch(
    `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  await expectOk(response, 'fetchRepoTree');
  const data = (await response.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };
  const paths = (data.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
  return { paths, truncated: data.truncated === true };
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
