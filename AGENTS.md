# AGENTS.md

Project guidance for coding agents. Follows the [agents.md](https://agents.md/) convention.

---

## Project at a glance

**PR Cascade** is a GitHub Pull Request review agent. It receives webhook events, runs a single model in v0.1 with a three-tier cascade arriving in v0.2, and posts structured review comments back to GitHub.

The project targets a better cost-quality trade-off than single-model review. A single frontier model on every request is often overkill for routine code review. Routing routine reviews to cheaper tiers preserves frontier quality on the cases that need it while keeping the average review cheap. The v0.2 cascade is where that thesis is tested.

---

## Setup commands

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Lint and format check
npm run check

# Auto fix format and safe lint issues
npm run format

# Run tests
npm test

# Run all checks (typecheck, lint plus format check, test)
npm run verify

# Local dev server with file watch
npm run dev
```

Production deployment runs through Railway and uses `npm run start` as the launch command.

---

## Tech stack

| Layer | Tool |
|---|---|
| Language | TypeScript strict |
| Runtime | Node 24 LTS |
| Framework | Hono via `@hono/node-server`. Hono is portable to Cloudflare Workers, though only the Node adapter is wired up today. |
| Hosting | Railway for v0.1 through v0.3 |
| Storage | In-memory map for v0.1 idempotency. Database in later versions. |
| LLM inference | OpenAI API. `gpt-5.4-mini` in v0.1. v0.2 cascade routes across `gpt-5.4-mini` (tier 1), `gpt-5.4` (tier 2), and `gpt-5.5` (tier 3 advisor). The earlier `gpt-5.X-codex` family is completion-only and incompatible with `chat.completions.parse`. |
| Observability | Local trace file for v0.1. Langfuse later. |
| Lint and format | Biome 2.x |
| Test | Vitest 4.x |
| Package manager | npm |
| CI | GitHub Actions |

---

## Code conventions

### TypeScript

- `strict: true` always. No `any` without a comment justifying why.
- Either type aliases or interfaces are fine for object shapes. Prefer interfaces for exported public shapes (better hover output and declaration merging); prefer type aliases for unions, tuples, and Zod-inferred types.
- Discriminated unions for sum types. Use `kind` or `type` as discriminator.
- Path alias `@/*` maps to `src/*`. Use absolute imports from `@/` for cross-directory references.

### Naming

- File names. kebab-case. `pr-review.ts`, not `prReview.ts` or `PRReview.ts`.
- Directory names. kebab-case.
- Types and classes. PascalCase inside files.
- Functions and variables. camelCase.
- Constants. UPPER_SNAKE_CASE only for true compile-time constants.
- Database tables and columns. snake_case (SQL convention).

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
import { createHmac } from 'node:crypto';

// 2. Third-party
import { z } from 'zod';

// 3. Internal absolute (@/)
import { verifyGitHubSignature } from '@/webhook/verify';

// 4. Internal relative (same dir)
import { parseDiffLocations } from './diff';
```

Biome handles import sorting automatically. Run `npm run format` before commit.

---

## File and directory structure (current v0.1)

```text
pr_review/
├── src/
│   ├── server.ts             Node entry, starts Hono on PORT
│   ├── app.ts                Hono routes for /health and /github/webhook
│   ├── env.ts                Zod env validation with .env.local loader
│   ├── lib/
│   │   ├── idempotency.ts    in memory map with 24h TTL
│   │   ├── cost.ts           per model pricing and cost cap enforcement
│   │   └── trace.ts          append JSON lines to traces/<date>.jsonl
│   ├── github/
│   │   ├── auth.ts           GitHub App JWT and installation token cache
│   │   ├── client.ts         REST calls for PR data, files, review post
│   │   └── diff.ts           parse unified diff for valid comment lines
│   ├── openai/
│   │   ├── schema.ts         Zod schema for review output
│   │   ├── prompt.ts         system prompt and diff formatter
│   │   └── review.ts         call OpenAI with structured output
│   └── webhook/
│       ├── verify.ts         HMAC SHA-256 with constant time compare
│       └── handler.ts        dispatch by event and run review pipeline
├── tests/                    Vitest specs, mirror src layout
├── .github/
│   ├── workflows/ci.yml      typecheck, lint, test, gitleaks
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── ISSUE_TEMPLATE/
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── README.md
├── ROADMAP.md
├── AGENTS.md                 This file
├── SECURITY.md
├── LICENSE
├── .gitignore
├── .nvmrc
└── .env.example
```

Future versions add `eval/` for Promptfoo fixtures, `infra/` for database schemas, and `training/` for fine-tune scripts.

---

## Critical rules

These are non-negotiable. Any code suggestion or generated commit that violates these must be flagged and corrected.

1. **No secrets in code or commits ever**. Even placeholder fake API keys should look obviously fake on inspection (for example, `your-api-key-here`).
2. **HMAC and signature comparison must be constant-time**. Use `node:crypto` `timingSafeEqual` on equal-length Buffer inputs, or the Web Crypto `crypto.subtle` equivalent when running on Workers. Never `===`.
3. **No real user data in test fixtures**. Synthetic only.
4. **Conventional Commits for all commit messages**. The exact format and allowed types live in the `Conventional Commits` section below.
5. **No `console.log` of prompts, API responses, or webhook bodies**. Use structured logging via observability layer.
6. **No `as any` or `as unknown as T` without comment**. These are escape hatches that hide bugs.
7. **No `--force` push on main branch**. Force-push on feature branches must use `--force-with-lease`.

---

## Conventional Commits

```text
<type>(<scope>): <imperative description under 72 chars>

<optional body explaining why, wrapped at 72 chars>

<optional footer such as BREAKING CHANGE or Fixes #N>
```

Allowed types. `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `style`.

Common scopes are the top level source directories (`webhook`, `github`, `openai`, `lib`, `server`) and the cross cutting areas (`ci`, `docs`, `config`). A more specific scope naming a single file or module (`handler`, `prompt`, `schema`, `trace`, `cost`, `client`, `auth`) is fine when the change is genuinely confined to that file. `router`, `sensor`, and `eval` become valid scopes once their v0.2 features land.

---

## What to do when you encounter the unfamiliar

- OpenAI SDK behavior, structured outputs, function calling, prompt caching. Verify at platform.openai.com/docs and the `openai` npm `helpers.md`.
- GitHub App authentication, webhook payload shapes, Reviews API line and side semantics. Verify at docs.github.com.
- Hono request, response, and adapter APIs. Verify at hono.dev.
- Node.js HTTP server lifecycle, signal handling. Verify at nodejs.org/api.
- When in doubt, link the doc URL in the PR description so the human maintainer can verify.

---

## Things this project explicitly does not do

- Multi-agent collaboration architectures. The project uses a cascade (sequential, deterministic) not multi-agent (parallel, coordinated).
- LangChain or LangGraph wrappers. Direct API calls everywhere.
- Custom inference serving infrastructure. The project relies on managed LLM APIs for v0.1 through v0.3.
- General-purpose chatbot interface. The system is event-driven only (GitHub webhooks).
- Mock LLM responses in unit tests. Tests cover deterministic logic (HMAC, diff parsing, idempotency, route dispatch). LLM calls are exercised through end-to-end smoke tests on real PRs.

---

## How to communicate uncertainty

If you are not sure about something (an OpenAI API behavior, a GitHub webhook payload field, a Hono adapter detail), write the code with a `// TODO(verify):` comment and a doc URL. Do not invent behavior. Do not assume.
