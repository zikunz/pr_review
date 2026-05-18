# PR Cascade

> A GitHub Pull Request review agent that posts inline comments. Every LLM finding is checked against the actual diff before posting, so reviewers never see a comment about a line the PR did not touch. A three-tier cost-aware model cascade ships in v0.2.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Overview

PR Cascade is a GitHub App that listens for pull request events and posts a structured code review with inline comments on each finding. It uses OpenAI for inference, validates that every proposed finding references a line that exists in the diff, and enforces a per-review cost cap. Triggers cover the `pull_request` events `opened`, `synchronize`, and `reopened`, plus an `@<bot-name>` mention in a PR comment for manual re-runs.

Detailed product spec lives in [ROADMAP.md](./ROADMAP.md).

## Architecture (v0.1)

```
GitHub PR event
        │
        ▼
POST /github/webhook
   verify HMAC SHA-256 (constant time)
   parse JSON body, check X-GitHub-Delivery idempotency
        │
        ▼
Return 202 Accepted, then async pipeline
   fetch PR head, files, and unified diff
   build prompt and call OpenAI with a Zod schema response_format
   drop any finding that does not reference a line in the diff
   post a Review with inline comments via the line+side API
   append cost, duration, and outcome to a local trace file
```

## Why this exists

Most automated code review tools treat the model as a black box and ship a single hardcoded provider. PR Cascade inverts that default. The routing logic, sensors, prompts, and verification approach are all in visible source.

Three ideas drive the design.

1. Verifiability over confidence. Every finding the bot posts has been checked against the unified diff that GitHub returned for the PR, so the bot cannot fabricate a comment about an untouched line. The model also reports its own confidence on every finding. Calibrating that self-reported number against ground truth is the v0.3 work.
2. Cost discipline. Each call writes a full token and cost ledger to the local trace file, and a per-review cost cap stops a single PR from blowing the budget. The v0.2 cascade keeps routine reviews on a small model and only escalates to a frontier model when the cheap tier is not confident.
3. Transparency. Prompts, schemas, and trace data formats are open so anyone can reproduce or critique the approach.

## Quickstart

Local development requires Node 24 or later and an OpenAI API key.

```bash
git clone https://github.com/zikunz/pr_review.git
cd pr_review
npm install
cp .env.example .env.local
# Fill in GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET,
# GITHUB_BOT_USERNAME, OPENAI_API_KEY in .env.local
npm run verify   # typecheck, lint, run every test
npm run dev      # starts on http://localhost:3000
```

To run end to end against a real PR, register a GitHub App, point its webhook at the public URL of your running instance (a `cloudflared` tunnel or `ngrok` pointed at `localhost:3000` works locally), and install the App on a test repository. Production deployment uses Railway. The full registration checklist lives in [ROADMAP.md](./ROADMAP.md).

## Tech stack

- Runtime. Node 24 LTS with TypeScript strict
- Framework. Hono via `@hono/node-server`. Hono was designed for Cloudflare Workers first, so the Workers migration in v0.4+ is a swap of the entry file and the trace sink, not a rewrite.
- LLM inference. OpenAI API. Single `gpt-5.3-codex` call in v0.1, three-tier cascade in v0.2.
- Hosting. Railway for v0.1 through v0.3
- Storage. In process map for idempotency in v0.1. SQLite or Postgres in later versions.
- Lint and format. Biome 2.x
- Test. Vitest 4.x
- CI. GitHub Actions runs typecheck, lint, tests, and a gitleaks secret scan on every push.

## Status board

| Component | Status |
|---|---|
| Webhook receiver with HMAC SHA-256 verification | Shipped (v0.1) |
| GitHub App authentication with installation token cache | Shipped (v0.1) |
| Fetch PR head, files, and unified diff with pagination | Shipped (v0.1) |
| Single model review with Zod structured output | Shipped (v0.1) |
| Inline comments via the GitHub Reviews API line plus side fields | Shipped (v0.1) |
| Idempotency store keyed on `X-GitHub-Delivery` with 24h TTL | Shipped (v0.1) |
| Per review cost cap with usage telemetry | Shipped (v0.1) |
| JSON Lines trace logging | Shipped (v0.1) |
| `@<bot-name>` mention re-trigger | Shipped (v0.1) |
| Graceful shutdown on SIGTERM and SIGINT | Shipped (v0.1) |
| Three tier cascade routing | Planned (v0.2) |
| Agentic tool use (context fetch, library docs, CI logs) | Planned (v0.2) |
| Persona system with `.cascade.yml` | Planned (v0.2) |
| Tool based verification with calibrated confidence | Planned (v0.3) |
| LoRA distillation pipeline | Future (v0.4+) |
| Cloudflare Workers migration | Future (v0.4+) |

## License

MIT. See [LICENSE](LICENSE).
