# PR Cascade

> A GitHub Pull Request review agent that posts inline comments, routes across model tiers for cost efficiency, and verifies LLM findings against the actual diff before posting.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What this is

PR Cascade is a GitHub App that listens for pull request events and posts a structured code review with inline comments on each finding. It uses OpenAI for inference, validates that every proposed finding references a line that exists in the diff, and enforces a per review cost cap. Triggers cover the standard PR lifecycle (open, push, reopen) plus an explicit `@bot review` mention for manual re-runs.

Detailed product spec lives in [ROADMAP.md](./ROADMAP.md).

## Architecture (v0.1)

```
GitHub PR event
        ↓
POST /github/webhook
   verify HMAC, check idempotency
        ↓
Async pipeline
   fetch PR data
   call LLM with structured output
   filter findings to lines that exist in the diff
   post Review with inline comments
   log cost and outcome to local trace file
```

## Why this exists

Most automated code review tools treat the model as a black box and ship a single hardcoded provider. This project goes the other direction. The routing logic, sensors, prompts, and verification approach are all visible source. The repository doubles as a working tool and a reference for the engineering patterns that separate a demo from a production LLM application.

Three ideas drive the design.

1. Verifiability over confidence. Every finding will eventually carry a calibrated confidence score, and the bot verifies each claim against the actual diff before posting it.
2. Cost discipline. Routine reviews stay on small models. Escalation to frontier models happens only when sensors fail or routing confidence is low. The full cost ledger is logged for every review.
3. Transparency. Prompts, eval methodology, and trace formats are open so anyone can reproduce or critique the approach.

## Tech stack

- Runtime. Node 24 with TypeScript strict
- Framework. Hono (universal across Node and Cloudflare Workers)
- LLM inference. OpenAI API for v0.1, cascade across multiple tiers in v0.2
- Hosting. Railway for v0.1 through v0.3
- Storage. In memory map for idempotency in v0.1. Database in later versions.
- Lint and format. Biome
- Test. Vitest
- CI. GitHub Actions

## Status board

| Component | Status |
|---|---|
| Webhook receiver with HMAC verification | Shipped (v0.1) |
| GitHub App authentication | Shipped (v0.1) |
| Fetch PR data and diff | Shipped (v0.1) |
| Single model review with structured output | Shipped (v0.1) |
| Inline comments via Reviews API | Shipped (v0.1) |
| Idempotency store | Shipped (v0.1) |
| Per review cost cap | Shipped (v0.1) |
| Trace logging | Shipped (v0.1) |
| @mention re-trigger | Shipped (v0.1) |
| Cascade routing | Planned (v0.2) |
| Agentic tool use (context fetch, library docs, CI logs) | Planned (v0.2) |
| Persona system with `.cascade.yml` | Planned (v0.2) |
| Tool based verification with calibrated confidence | Planned (v0.3) |
| LoRA distillation pipeline | Future (v0.4+) |
| Cloudflare Workers migration | Future (v0.4+) |

## License

MIT. See [LICENSE](LICENSE).
