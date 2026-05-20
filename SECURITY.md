# Security Policy

## Project status

This project is in active development. The latest commit on `main` is the only supported version. There are no formal releases yet.

## Reporting a vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

**Preferred channel**. Use [GitHub Private Vulnerability Reporting](https://github.com/zikunz/pr_review/security/advisories/new) on this repository. This creates a private advisory visible only to maintainers.

If GitHub private reporting is unavailable, contact the maintainer via the email listed on their GitHub profile with the subject line beginning `[SECURITY]`.

You can expect the following from maintainers.

- Acknowledgment within 72 hours.
- Initial status update within 7 days.
- A fix and disclosure plan within 30 days for confirmed issues.

## Scope

In scope.
- Webhook signature verification bypass
- HMAC timing attacks
- Authentication or authorization issues in any administrative endpoint
- Secret exposure via logs, response bodies, or error messages
- Remote code execution vulnerabilities
- Prompt injection enabling exfiltration of secrets or sensitive context
- Unauthorized access to GitHub App installation tokens or webhook payloads

Out of scope.
- Issues in third party services we depend on (please report to them)
- Denial of service via legitimate API usage at scale
- Social engineering of users
- Spam or content abuse not specific to this codebase

## Disclosure

After a fix is deployed, the reporter is credited in release notes unless anonymity is requested.

## Maintainer security practices

- All production secrets stored as Railway service environment variables, never in source. Local development uses a gitignored `.env.local` file.
- HMAC signature verification uses constant time comparison.
- GitHub Actions CI runs gitleaks on every push to scan for accidentally committed secrets.
- Public webhook endpoints validate every request signature before any business logic.
- The `@<bot-name>` manual re-trigger path is restricted to commenters whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`. Outside contributors cannot drive cost amplification by spamming mentions on open pull requests.
- Trace records emitted to disk and stdout strip both sensitive-named object keys and secret-shaped substrings (`sk-`, `ghp_`, `ghs_`, `gho_`, `github_pat_`, PEM blocks) so an upstream error message that quotes a credential does not land in logs verbatim.
- Outbound calls to GitHub carry a 30-second `AbortSignal.timeout`. The OpenAI client has an explicit 60-second ceiling. A stuck connection cannot pin a review promise for the lifetime of the container.
