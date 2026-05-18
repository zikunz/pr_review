# AGENTS.md

Project guidance for coding agents. Follows the [agents.md](https://agents.md/) convention.

---

## Project at a glance

**PR Cascade** is a GitHub Pull Request review agent. It receives webhook events, runs a four-tier model cascade (small open-source models for routine reviews, frontier closed models as advisor for hard cases), and posts structured review comments back to GitHub.

The project optimizes for the cost-quality Pareto frontier of LLM application engineering. Most production LLM apps overpay by 10x or more by using a single frontier model for every request. PR Cascade demonstrates that thoughtful routing across tiers can match frontier quality at a fraction of the cost.

---

## Setup commands

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Lint and format check
npm run check

# Auto-fix format and safe lint issues
npm run format

# Run tests
npm test

# Run all checks (typecheck, lint, format, test)
npm run verify

# Local dev (Cloudflare Workers)
npm run dev

# Deploy to Cloudflare
npm run deploy
```

---

## Tech stack

| Layer | Tool |
|---|---|
| Language | TypeScript strict |
| Runtime | Cloudflare Workers |
| Workflow | Cloudflare Workflows |
| Storage | D1 (relational), R2 (blobs), KV (cache), Durable Objects (coordination) |
| LLM inference | OpenAI API (`gpt-5.3-codex` for v0.1, cascade across `gpt-5.4-mini` and `gpt-5.5` in v0.2) |
| Frontend (Phase 2) | Next.js on Cloudflare Pages |
| Observability | Langfuse + Sentry |
| Lint and format | Biome (single tool) |
| Test | Vitest |
| Package manager | npm |
| CI | GitHub Actions |
| Deploy | Wrangler |

---

## Code conventions

### TypeScript

- `strict: true` always. No `any` without a comment justifying why.
- Prefer types over interfaces for object shapes unless declaration merging is needed.
- Discriminated unions for sum types. Use `kind` or `type` as discriminator.
- Path alias `@/*` maps to `src/*`. Use absolute imports from `@/` for cross-directory.

### Naming

- File names. kebab-case. `pr-review.ts`, not `prReview.ts` or `PRReview.ts`.
- Directory names. kebab-case.
- Types and classes. PascalCase inside files.
- Functions and variables. camelCase.
- Constants. UPPER_SNAKE_CASE only for true compile-time constants.
- Database tables and columns. snake_case (D1 / SQL convention).

### Error handling

- Never silently swallow errors. Either handle, log structured, or rethrow.
- Use structured error types with discriminated union over generic `Error`.
- Boundary functions (webhook handler, API endpoints) catch and convert to appropriate HTTP responses. Internal functions throw.

### Comments

- Default to no comments. Well-named identifiers should communicate intent.
- Add a comment only when the code embodies a non-obvious decision, references an external bug or quirk, or contains a workaround.
- Never describe what the code does. Describe why it does it that way.
- Never write comments referencing the current PR or task or person. Those belong in commit messages, not code.

### Imports

```typescript
// Order
// 1. Node built-ins
import { Buffer } from 'node:buffer';

// 2. Third-party
import { z } from 'zod';

// 3. Internal absolute (@/)
import { verifyHmacSignature } from '@/crypto';

// 4. Internal relative (same dir)
import { parsePayload } from './parser';
```

Biome handles import sorting automatically. Run `npm run format` before commit.

---

## File and directory structure

```
pr_review/
├── src/
│   ├── index.ts              # Worker entrypoint
│   ├── webhook.ts            # GitHub webhook receiver
│   ├── crypto.ts             # HMAC verification
│   ├── github.ts             # GitHub API client
│   ├── workflows/
│   │   └── pr-review.ts      # Main Cloudflare Workflow
│   ├── cascade/
│   │   ├── router.ts         # Tier selection
│   │   ├── tiers.ts          # Tier definitions
│   │   └── sensors.ts        # Quality sensors
│   ├── eval/
│   │   ├── assertions.ts     # Code-based eval
│   │   └── judge.ts          # LLM-as-judge eval
│   └── env.ts                # Typed env bindings
├── tests/
│   ├── unit/
│   └── integration/
├── eval/
│   ├── promptfooconfig.yaml
│   └── fixtures/             # synthetic only
├── infra/
│   ├── d1-schema.sql
│   └── migrations/
├── docs/
│   ├── ARCHITECTURE.md
│   └── RUNBOOK.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── wrangler.jsonc            # Cloudflare Workers config (JSONC recommended since Wrangler 4.x)
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── README.md
├── AGENTS.md                 # This file
├── SECURITY.md
├── LICENSE
├── .gitignore
└── .env.example
```

---

## Critical rules

These are non-negotiable. Any code suggestion or generated commit that violates these must be flagged and corrected.

1. **No secrets in code or commits ever**. Even placeholder fake API keys should look syntactically obviously fake (e.g., `your-api-key-here`).
2. **HMAC and signature comparison must be constant-time**. Use `crypto.subtle` `timingSafeEqual` pattern or equivalent. Never `===`.
3. **No real user data in test fixtures**. Synthetic only.
4. **Conventional Commits for all commit messages**. See ROADMAP.md for cadence and message structure.
5. **No `console.log` of prompts, API responses, or webhook bodies**. Use structured logging via observability layer.
6. **No `as any` or `as unknown as T` without comment**. These are escape hatches that hide bugs.
7. **No `--force` push on main branch**. Force-push on feature branches must use `--force-with-lease`.

---

## Conventional Commits

```
<type>(<scope>): <imperative description under 72 chars>

<optional body explaining why, wrapped at 72 chars>

<optional footer such as BREAKING CHANGE or Fixes #N>
```

Allowed types. `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `style`.

Common scopes. `webhook`, `router`, `sensor`, `eval`, `frontend`, `infra`.

---

## What to do when you encounter the unfamiliar

- Cloudflare APIs change. Always check the latest docs at developers.cloudflare.com before generating Workers, Workflows, D1, R2, KV, Durable Objects, Workers AI, or Vectorize code.
- GitHub App and webhook semantics. Verify at docs.github.com.
- OpenAI API. Verify at platform.openai.com/docs.
- When in doubt, link to the doc URL in the PR description so the human maintainer can verify.

---

## Things this project explicitly does not do

- Multi-agent collaboration architectures. We use a cascade (sequential, deterministic) not multi-agent (parallel, coordinated). Multi-agent is overhyped for this domain.
- LangChain or LangGraph wrappers. Direct API calls everywhere.
- Custom inference serving infrastructure. We rely on Cloudflare Workers AI for open-source model inference.
- General-purpose chatbot interface. The system is event-driven only (GitHub webhooks).
- Mock LLM responses in tests. Tests either use real models against synthetic prompts or use deterministic fixtures.

---

## How to communicate uncertainty

If you are not sure about something (a Cloudflare API behavior, a Workers AI model availability, a GitHub webhook field), write the code with a `// TODO(verify):` comment and a doc URL. Do not invent behavior. Do not assume.
