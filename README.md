# PR Cascade

> Production-grade GitHub Pull Request review agent with cost-aware model cascade routing.

[![Status](https://img.shields.io/badge/status-active%20development-yellow)](https://github.com/zikunz/pr_review)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What this is

PR Cascade automatically reviews GitHub Pull Requests using a four-tier model cascade. Routine PRs route to small open-source models for cost efficiency. Complex changes escalate to frontier closed models only when needed. Every output passes through validation sensors before being posted.

The goal is to demonstrate that **thoughtful routing across a model cascade can match the quality of frontier closed models at a fraction of the cost**.

## Architecture (v0.1)

```
GitHub PR opened
      ↓
Webhook receiver
   verify HMAC, check idempotency
      ↓
Async pipeline
   fetch PR data → call LLM → validate findings → post review
      ↓
GitHub PR Review with inline comments
```

Detailed cascade and verification architecture lives in [ROADMAP.md](./ROADMAP.md).

## Current status

Active development. Architecture finalized 2026-05-18. First end-to-end review flow targeted for late May 2026. Public beta opening through CS153 Frontier Systems final project demo June 2026.

Detailed design document at [github.com/zikunz/proposals](https://github.com/zikunz/proposals).

## Build in public

Following along.

- **Code**. This repository.
- **Twitter**. [@zikunz](https://twitter.com/zikunz)  (replace with actual handle)
- **Blog**. zikun.dev  (coming soon)
- **小红书**. (coming soon)

Weekly technical posts cover architecture decisions, fine-tune results, eval findings, and cost-quality trade-offs.

## Why this exists

Built as a personal exploration project to deeply understand production LLM application engineering. The specific technical contributions of interest:

- Cost-aware cascade routing with confidence-calibrated tier selection
- Multi-sensor output validation including hallucination detection against real diff content
- LoRA distillation from a frontier model to a small open-source model with edge inference deployment (v0.4+)
- Eval flywheel driven by real production traces from GitHub user feedback signals

PR review is the vehicle. The patterns transfer to any production LLM agent.

## Tech stack

- **Runtime**. Cloudflare Workers (TypeScript)
- **Workflow engine**. Cloudflare Workflows
- **Storage**. Cloudflare D1, R2, KV, Durable Objects, Vectorize
- **LLM inference**. OpenAI API for v0.1, cascade across multiple OpenAI tiers in v0.2
- **Frontend**. Next.js on Cloudflare Pages
- **Observability**. Langfuse
- **Eval**. Promptfoo
- **Training**. DigitalOcean GPU droplet with Unsloth for LoRA fine-tuning

## Status board

| Component | Status |
|---|---|
| Architecture design | Complete |
| Repo and project skeleton | In progress (this commit) |
| GitHub App registration | Pending |
| Webhook handler | Pending |
| Cascade router (rule-based) | Pending |
| Cascade router (classifier-based) | Future |
| Sensor layer | Pending |
| End-to-end Workflow | Pending |
| Frontend dashboard | Pending |
| LoRA fine-tune pipeline | Future |
| Eval flywheel | Future |
| Public beta | Target June 2026 |

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

Built during Stanford CS153 Frontier Systems Spring 2026 under instructors Anjney Midha and Michael Abbott. Compute infrastructure provided by Cloudflare for Startups program and DigitalOcean education credits.
