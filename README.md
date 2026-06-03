# PR Cascade

> A GitHub Pull Request review agent that posts inline comments. Every LLM finding is checked against the actual diff before posting, so reviewers never see a comment about a line the PR did not touch. A diff-driven three-tier model cascade and a refutation-first verification gate ship behind environment flags.

[![CI](https://github.com/zikunz/pr_review/actions/workflows/ci.yml/badge.svg)](https://github.com/zikunz/pr_review/actions/workflows/ci.yml)
[![Node 24](https://img.shields.io/badge/node-24%20LTS-brightgreen)](./.nvmrc)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## Overview

PR Cascade is a GitHub App that listens for pull request events and posts a structured code review with inline comments on each finding. It uses an OpenAI-compatible API for inference, validates that every proposed finding references a line that exists in the diff, and enforces a per-review cost cap. Triggers cover the `pull_request` events `opened`, `synchronize`, and `reopened`, plus an `@<bot-name>` mention by a repository owner, member, or collaborator for manual re-runs. Comments from outside contributors are ignored so a public repo cannot be cost-amplified by drive-by mentions.

**See it in action:** [the bot reviewing a demo pull request](https://github.com/zikunz/pr_review/pull/15), where it flags a planted SQL injection as a critical finding at 0.99 confidence and a missing-parameter crash as a warning.

Detailed product spec lives in [ROADMAP.md](./ROADMAP.md). An offline evaluation of review quality is in [docs/evaluation.md](./docs/evaluation.md).

That evaluation produced a clear headline finding. Across 22 real merged pull requests, the cheap deployed model is noisy (26 findings, nearly all false positives) while stronger models stay quiet on the same code, yet every OpenAI model tested catches 100% of planted, diff-evident bugs. So for code review the differentiator is precision, not recall. A refutation-first verification gate built on that insight removes 24 of those 26 noisy findings while preserving every planted-bug catch.

## Architecture (v0.1)

```text
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
   append duration, outcome, and cost (on success) to stdout and a local trace file
```

## Why this exists

Most automated code review tools treat the model as a black box and ship a single hardcoded provider. PR Cascade inverts that default. The routing logic, prompts, schemas, and verification approach are all in visible source.

Three ideas drive the design.

1. Verifiability over confidence. Every finding the bot posts has been checked against the unified diff that GitHub returned for the PR, so the bot cannot fabricate a comment about an untouched line. The model also reports its own confidence on every finding. Calibrating that self-reported number against ground truth is Experiment 10, which finds it badly overconfident (Expected Calibration Error 0.76, with the most confident findings wrong every time), so the bot relies on the verification gate rather than the confidence number to filter noise.
2. Cost discipline. Successful calls write a token and cost ledger to the local trace file. Failures that occur after the LLM call has already been billed are logged as `review.failed` with the error and duration, but without the cost figure. A `review.cost_settled` pre-post event is a v0.2 candidate. A per-review cost cap suppresses the posted review when the call exceeded its budget, leaving an audit trail so a runaway PR cannot also flood the comments. Pre-flight cost estimation is the other v0.2 candidate. The planned v0.2 cascade keeps routine reviews on a small model and escalates to a frontier model only when sensors fail or routing confidence is low.
3. Transparency. Prompts, schemas, and trace data formats are open so anyone can reproduce or critique the approach.

## Quickstart

Local development requires Node 24 or later and an OpenAI API key (or an OpenRouter key plus `OPENAI_BASE_URL=https://openrouter.ai/api/v1`).

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

To run end-to-end against a real PR, register a GitHub App and install it on a test repository. Point the App's webhook at the public URL of your running instance. A `cloudflared` tunnel or `ngrok` pointed at `localhost:3000` works locally. Production deployment uses Railway. The full registration checklist lives in [ROADMAP.md](./ROADMAP.md).

### Optional: verification gate

Set `VERIFY_ENABLED=true` to route every finding that passes diff-anchor validation through a refutation-first second model before it is posted. A finding is dropped only when the verifier panel unanimously judges it a false positive, so a diff-confirmed bug is kept while an unconfirmed claim is removed. `VERIFY_MODELS` is a comma-separated list of verifier slugs (default `gpt-5.5`, in the same form as `OPENAI_MODEL`, so use the `openai/gpt-5.5` form when routing through OpenRouter). The gate is off by default and adds one verifier call per finding for each model in `VERIFY_MODELS`, so the default single-model panel adds one call per finding. The approach was validated offline before it was wired in.

## Tech stack

- Runtime. Node 24 LTS with TypeScript strict
- Framework. Hono via `@hono/node-server`. Hono was designed for Cloudflare Workers first, so the v0.4+ Workers migration is a swap of four files at the platform-coupled edges (entry, trace sink, dotenv loader, HMAC verifier) plus a swap of the JWT private-key loader (currently `node:crypto.createPrivateKey`) for `crypto.subtle.importKey`, and a move of the idempotency store from a process-local `Map` to Workers KV or a Durable Object. The `jose` JWT signer itself already runs on Workers' Web Crypto. The business logic ports unchanged.
- LLM inference. OpenAI-compatible API. Single `gpt-5.4-mini` call in v0.1, three-tier cascade in v0.2. Set `OPENAI_BASE_URL` to route through OpenRouter (one key for all providers) instead of calling OpenAI directly.
- Hosting. Railway for v0.1 through v0.3
- Storage. In-process map for idempotency in v0.1. SQLite or Postgres in later versions.
- Lint and format. Biome 2.x
- Test. Vitest 4.x
- CI. GitHub Actions runs typecheck, lint, tests, and a gitleaks secret scan on every push to `main` and every pull request.

## Status board

| Component | Status |
|---|---|
| Webhook receiver with HMAC SHA-256 verification | Shipped (v0.1) |
| GitHub App authentication with installation token cache | Shipped (v0.1) |
| Fetch PR head, files, and unified diff with pagination | Shipped (v0.1) |
| Single model review with Zod structured output | Shipped (v0.1) |
| Inline comments via the GitHub Reviews API `line` and `side` fields | Shipped (v0.1) |
| Idempotency store keyed on `X-GitHub-Delivery` with 24h TTL | Shipped (v0.1) |
| Per-review cost cap with usage telemetry | Shipped (v0.1) |
| JSON Lines trace logging with secret-shaped substring redaction | Shipped (v0.1) |
| `@<bot-name>` re-trigger from owners, members, and collaborators | Shipped (v0.1) |
| Graceful shutdown drains in-flight reviews on SIGTERM, SIGINT, and fatal process errors up to a 10-second ceiling | Shipped (v0.1) |
| Diff-driven three-tier cascade routing (`CASCADE_ENABLED`) | Built, off by default |
| Agentic tool use (context fetch, library docs, CI logs) | Planned (v0.2) |
| Persona system with `.cascade.yml` | Planned (v0.2) |
| Model-based refutation-first verification gate (`VERIFY_ENABLED`) | Built, off by default |
| Tool-based verification with calibrated confidence | Planned (v0.3) |
| LoRA distillation pipeline | Future (v0.4+) |
| Cloudflare Workers migration | Future (v0.4+) |

## Evaluation

[docs/evaluation.md](./docs/evaluation.md) reports an offline evaluation built on the bot's exact review path. It runs ten experiments anchored on a frozen set of 22 real merged pull requests from React, FastAPI, Spring Boot, and Axios. The sharpest single result is Experiment 10, the confidence calibration shown below: the models report high confidence on findings that are almost never real.

![Reliability diagram of the deployed models' confidence over the 83 hand-scored findings. Model self-reported confidence is on the x-axis and the actual fraction of real findings on the y-axis. A calibrated model would follow the dashed diagonal, but observed accuracy stays near zero across the whole range, and the gap to the diagonal is widest at the highest confidence.](./docs/reliability.svg)

1. **Cross-model noise panel.** The same 22 PRs through five models. The deployed model (gpt-5.4-mini) posted 26 findings, nearly all false positives including three confident criticals that were wrong. gpt-5.5 and gpt-5.3-codex posted 6 and 5 on the same code.
2. **Recall test.** Eight diffs with one planted, diff-evident bug each. All three OpenAI models caught 8/8.
3. **Verification layer.** A refutation-first second model audits each finding against the diff. Over mini's 26 findings it removed 24 (including all three confident criticals) and kept the 2 plausibly-real ones, and over the eight planted bugs it kept 8/8.
4. **Grounding (precision axis).** Re-reviewing with the full file (the frontier "give the model codebase context" fix) did not reduce noise. Findings went 26 → 28 and criticals 3 → 5, and the flagship false positive recurred in 4/4 grounded runs with the relevant definition present in context.
5. **Cross-file recall axis.** On five planted bugs whose cause lives in another file, giving the model that dependency raised hand-verified recall from 1/15 to 8/15, but only on the three where it used the stated contract. The other two were missed even with the dependency in context.
6. **Cross-vendor verification.** Re-running the gate with cross-vendor verifiers over mini's 26 findings. Gemini 3.1 Pro killed 25/26 and Opus 4.8 killed 23/26, agreeing with the same-vendor panel on 23 to 25 of 26, so the gate's noise removal is not a same-vendor artifact. The one split was Opus keeping the axios false positive that needs out-of-diff context to refute.
7. **Multi-agent review.** A planner, reviewer, and critic pipeline on gpt-5.5 posted 9 findings on the 22 PRs versus 6 for single-pass, while preserving 8/8 planted-bug recall. The collaboration made the review more thorough rather than more precise, the opposite direction from the verification gate.
8. **Per-finding precision audit.** Every finding the six configurations posted (83 in total) was hand-scored against the code. There was one clear true positive, surfaced by three configurations, and roughly 80 false positives. Every finding at confidence 0.95 or above was wrong, which confirms that precision, not recall, is the bottleneck and that model confidence does not track correctness.
9. **Gate against ground truth.** Running the production verification gate over all 83 findings, measured against the hand-scored labels, dropped 85% of the false positives across every configuration while preserving the one real bug. A refutation-first gate is a general precision filter, not a tweak that only helps the cheap model.
10. **Confidence calibration.** Scoring the self-reported confidence against the hand labels gives an Expected Calibration Error of 0.76 and a Brier score of 0.63, against 0 for a perfect predictor. Mean confidence was 0.80 while actual accuracy was 0.036, and the 13 findings at 0.95 confidence or above were wrong every time. The confidence number carries almost no signal about whether a finding is real, so a tool cannot filter noise by thresholding on it, which is why the verification gate re-judges each finding against the diff instead.

Across experiments 4 and 5 the bottleneck is consistently the model's *use* of context, not its availability, which is why context-grounding and the verification gate are complementary rather than competing.

The harness and frozen data are in [`eval/`](./eval) and the run is reproducible with the commands in the evaluation document. Every number is checked against the raw result files. The writeup also lists the methodology's limitations (small sample, planted-bug recall only, same-vendor noise comparison, single coder, single grounding run per condition).

## Limitations

- v0.1 keeps idempotency state in the process memory. A restart drops the cache. GitHub may redeliver a webhook seen before the restart and the bot will re-review.
- Diffs whose patch content totals more than 200K characters are skipped (logged as `review.skipped` with reason `diff exceeds prompt size cap`). Per-file chunking is a v0.2 candidate.
- The per-review cost cap stops the bot from posting a review whose cost exceeds the cap, but the LLM call has already completed by the time the cap is checked. Pre-flight cost estimation is a v0.2 candidate.
- `pull_request.opened`, `synchronize`, and `reopened` events from any author trigger a review, including drive-by fork contributors. Each push by the same author incurs a fresh OpenAI call before the per-review cap can suppress the posted output, so cumulative call-time cost from repeated pushes is uncapped today. Per-repo and per-day cost caps are a v0.2 candidate.
- The review path fetches the current PR head, not the head SHA GitHub signed in the webhook payload. A force-push between webhook delivery and fetch swaps the reviewed content, and the posted review carries the new commit SHA. Comparing the fetched head against the signed head before reviewing is a v0.2 candidate.
- The webhook scheduler is fire-and-forget. A burst of qualifying webhooks (a force-push storm, a `synchronize` flood from a rebase loop, comment-mention spam from an authorized commenter) launches that many simultaneous OpenAI calls. The per-review cost cap suppresses the posted reviews but does not bound call-time spend, so the only call-time ceilings on a burst are the per-call token limits and the OpenAI org-level quota. A per-installation in-flight semaphore is a v0.2 candidate.
- The Markdown escape chain on posted findings defangs `& < > [ ]` but not `@`-mentions, `#`-issue references, or bare URLs. A PR title or body containing text the model echoes verbatim into a finding can produce unintended pings or autolinked URLs in the bot's posted comments. Extending the escape chain is a v0.2 candidate.
- Draft pull requests are reviewed the same as ready pull requests, and the `ready_for_review` action is not in the allowlist. A developer iterating on a draft burns a full review per `synchronize` push, and the natural "draft is now ready" signal does not fire a fresh review on the ready-state diff. Skipping `pr.draft === true` and adding `ready_for_review` to the trigger set are a v0.2 candidate.
- PRs with more than `MAX_PR_FILE_PAGES * 100 = 3,000` changed files trigger a partial review of the first 3,000 files. The posted review body explicitly discloses the truncation. Trace events also carry `filesTruncated: true`. Per-file chunking that lets the bot review the remainder in follow-up calls is a v0.2 candidate.
- Cascade routing and the model-based verification gate are built but ship off by default behind `CASCADE_ENABLED` and `VERIFY_ENABLED`. Persona config, agentic tool use, and the calibrated-confidence (AST-based) verifier remain roadmap items that are not built yet.

## AI tools disclosure

This project was built with heavy use of AI tooling, which the course encourages. This section states how and where.

- **Development assistant.** Most of the implementation code, the test suites, the evaluation harness in [`eval/`](./eval), and the prose in this README, [ROADMAP.md](./ROADMAP.md), and [docs/evaluation.md](./docs/evaluation.md) were produced with an AI coding agent (Anthropic's Claude Code). The author directed the work end to end: setting the architecture and scope, defining the evaluation methodology and scoring rubric, choosing the models and the cascade and verification designs, and verifying every quantitative claim against the raw result files and live API runs before committing it.
- **Adversarial review.** Code changes were re-reviewed by AI review passes acting as independent skeptics. The author checked each finding against the source before acting on it rather than trusting the review output.
- **Runtime inference.** The bot itself calls OpenAI `gpt-5.x` models for code review, routed through OpenRouter, configured via the `OPENAI_*`, `CASCADE_*`, and `VERIFY_*` environment variables. This is the product's runtime dependency, separate from the development tooling above.
- **Author ownership.** The choice of problem, the evaluation design, the interpretation of the results, and every decision about what to ship were the author's, and all reported numbers were verified against source data before publication.

## Security

See [SECURITY.md](./SECURITY.md) for the vulnerability disclosure process and the maintainer practices that apply to this repository.

## License

MIT. See [LICENSE](./LICENSE).
