# Roadmap

Canonical product spec for PR Cascade. Last updated 2026-05-20.

## Identity

PR Cascade is a GitHub Pull Request review agent that demonstrates production engineering for LLM applications. It posts inline review comments and verifies every finding against the PR diff before posting. A model cascade for cost efficiency lands in v0.2.

## Why this exists

Most automated code review tools treat the model as a black box and ship a single hardcoded provider. PR Cascade inverts that default. The routing logic, prompts, schemas, and verification approach are all in visible source. The repository is both a working tool and a reference implementation. Cascade routing and format-and-safety sensors land in v0.2.

Three ideas drive the design.

1. Verifiability over confidence. Each finding carries a model-declared confidence score. The bot verifies that every claim references a line in the diff. Calibrating that confidence score against verification evidence is the v0.3 work.
2. Cost discipline. The v0.2 cascade will keep routine reviews on a small model and escalate to a frontier model only when sensors fail or routing confidence is low. The cost ledger is logged for every review today.
3. Transparency. Prompts, eval methodology, and trace data formats are open so anyone can reproduce or critique the approach.

## Non-goals

This project explicitly does not do the following.

- Automatic PR approval. The bot only comments.
- Blocking merges. Required check status is never set.
- Modifying source code. The bot never pushes commits or opens PRs.
- Replacing human reviewers. The bot supplements human review.
- Cross-platform support. GitHub only.
- Real-time chat. Findings post once. The bot does not engage in PR threads.
- Multi-agent collaboration. The system uses sequential cascade routing, not concurrent multi-agent.
- Language specialization. The bot reviews any language the underlying model handles. No per-language plugin system.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS | Railway hosting for v0.1 through v0.3 |
| Framework | Hono with `@hono/node-server` | Portable to Cloudflare Workers later via a four-file swap (entry, trace sink, dotenv loader, HMAC verifier) |
| Language | TypeScript strict | No `any` without justification |
| LLM (v0.1) | `gpt-5.4-mini` via OpenAI API | The `gpt-5.X-codex` family is completion-only and rejects `chat.completions.parse`. Verify pricing at platform.openai.com before committing cost estimates |
| LLM (v0.2 cascade) | Tier 1 `gpt-5.4-mini`, Tier 2 `gpt-5.4`, Tier 3 `gpt-5.5` advisor | All OpenAI for v0.2. Multi-provider cascade becomes a v0.4+ exploration |
| Auth | GitHub App with JWT signed installation tokens | Standard pattern |
| Lint and format | Biome 2.x | Single tool |
| Test | Vitest 4.x | |
| CI | GitHub Actions | Typecheck, lint, test, gitleaks secret scan |
| Observability (v0.2+) | Langfuse cloud free tier initially | Self host for v0.3 |
| Package manager | npm | |

Cloudflare Workers is an intentional v0.4 target. Hono was designed for Workers first. The business logic in this repository does not depend on Node-specific APIs outside four files. The entry file (`src/server.ts`), the trace sink (`src/lib/trace.ts`), the dotenv loader (`src/env.ts`), and the HMAC verifier (`src/webhook/verify.ts`) swap as a group. The rest of the codebase ports unchanged.

## Architecture (v0.1)

```text
GitHub PR opened or synced
        │
        ▼
POST /github/webhook
        │
        ▼
verify HMAC SHA-256 in constant time
        │
        ▼
parse JSON body and check idempotency on X-GitHub-Delivery
        │
        ▼
return 202 Accepted within the GitHub 10s budget
        │
        ▼
async pipeline
        │
   ┌────┴────┐
   │ fetch    │  GitHub App JWT → installation token → PR data, files, diff
   │ analyze  │  build prompt → gpt-5.4-mini with response_format → Zod parse
   │ validate │  verify every finding line exists in diff
   │ post     │  Reviews API with line+side inline comments
   │ log      │  cost, duration, finding count to local trace file
   └─────────┘
```

## Version roadmap

Milestones are ordered, not scheduled. Each version is shippable on its own.

| Version | Theme |
|---|---|
| v0.1 | Single model end-to-end on Railway |
| v0.2 | Cascade plus agentic tools plus persona system |
| v0.3 | Tool-based verification with calibrated confidence |
| v0.4 | LoRA distillation and Cloudflare Workers migration |
| v0.5+ | Adversarial robustness and online learning |

### v0.1 scope

The smallest viable end-to-end pipeline.

In scope.

- Webhook reception with HMAC verification and idempotency
- GitHub App installation token authentication
- Fetch PR metadata, files, and diff
- Single `gpt-5.4-mini` call per review with structured JSON output
- Single hardcoded persona named senior software engineer (matches the wording in `src/openai/prompt.ts`)
- PR Review with inline comments via `line` plus `side` API
- Per-review cost cap (default $0.30, configurable via `COST_CAP_CENTS_PER_REVIEW`). Reviews exceeding the cap are skipped and logged.
- Idempotency via in-memory map keyed by delivery ID, 24 hour TTL
- Local file logging for traces
- Triggers on `pull_request.opened`, `synchronize`, `reopened`
- Manual re-trigger on `issue_comment.created` when a repository owner, member, or collaborator mentions the bot (any `@<bot-name>` reference, optionally followed by the `[bot]` suffix). Comments from `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `MANNEQUIN`, and `NONE` author associations are ignored.
- Deploy to Railway with `/health` endpoint

Not in v0.1. Cascade, persona config, auto-detection, agentic tools, repository-wide context, AST and tool-based verification, eval pipeline, frontend dashboard. Diff-line validation (the lightweight verification that ships in v0.1) is in scope above. v0.3 adds the deeper tool-based layer.

### v0.2 scope

Adds production sense and configurability. Reuses v0.1 plumbing.

New capabilities.

1. **Cascade routing** across three tiers driven by complexity heuristics. Tier 1 handles small diffs and docs-only changes. Tier 2 handles ordinary code changes. Tier 3 escalates only on sensor failure or low confidence.
2. **Agentic tool use** via OpenAI function calling. Four tools.
   - `read_related_file(path)` for context outside the diff
   - `find_test_for(source_file)` to locate test files by naming convention
   - `fetch_library_docs(library, query)` via the Context7 HTTP API
   - `fetch_ci_logs(check_run_id)` via GitHub Checks API
3. **Persona system** with five presets accessible via `.cascade.yml`. Presets are `prototype`, `production`, `mentor`, `security_audit`, `concise`.
4. **First PR onboarding callout** that explains persona selection on the first review in a repo.
5. **Langfuse integration** for trace observability.
6. **Promptfoo regression suite** in CI.

### v0.3 scope

The frontier piece. Tool-based verification with calibrated confidence.

This is what differentiates the project from commercial bots and the only component that is genuinely frontier in 2026.

New capabilities.

1. **AST parsing** via `tree-sitter`. For each finding, verify that the referenced line is the type of construct the LLM claims (function call, null deref, etc.).
2. **Cross-file symbol resolution** via lightweight import graph. Detect findings that reference non-existent functions, classes, or types.
3. **Control flow heuristic**. Scan 30 lines preceding a proposed null deref for null guards. Detect optional chaining (`?.`), nullish coalescing, type narrowing patterns.
4. **Test coverage signal**. Findings on lines exercised by tests get a confidence penalty.
5. **Confidence aggregation**. Combine LLM stated confidence with verification evidence into final score. Findings below threshold (default 0.5) drop. Findings above 0.85 always post. Mid range tagged for human attention.
6. **Auto-detect persona** when no `.cascade.yml` exists. Signals are README content, CI presence, repo age, sensitive path patterns.
7. **Per PR override** via PR label (`cascade:lenient`, `cascade:strict`) or description hint.
8. Eval metrics dashboard for review of aggregate accuracy and cost trends across repos. Surface is internal first, public later when the data justifies it.

Target outcome. The v0.1 production traces establish the baseline false-positive rate. v0.3 verification aims to cut it by at least half. Precise numbers go in the v0.3 ship blog after measurement, not in this roadmap.

### v0.4 and beyond

Not committed. Listed for direction.

- LoRA fine-tune of Mistral 7B Instruct v0.2 on a self-collected, permissively licensed review dataset, served via Cloudflare Workers AI as the tier-1 router target
- Migration of full stack to Cloudflare Workers when Startups credits arrive
- Adversarial robustness study with prompt injection PR corpus and defensive sensor
- Cross-codebase pattern recognition via vector database of historical PR outcomes
- Verified execution via sandboxed test runs

## Personas and config

The default persona for v0.1 is senior software engineer. The full prompt lives in `src/openai/prompt.ts`. The summary below mirrors what the prompt enforces.

```text
Focus     bugs, security, performance, API misuse, concurrency
Ignore    style, naming, subjective architecture choices
Tone      direct and constructive
Findings  schema caps the array at five, prompt asks the model to prefer quality over quantity
Threshold the model assigns a confidence per finding. A post side threshold lands in v0.2
```

Starting v0.2 (planned), users override via `.cascade.yml` in the repo root.

```yaml
preset: production
```

Finer control.

```yaml
persona: senior_engineer
focus:
  bugs: high
  security: high
  performance: medium
  style: off
tone: direct
max_findings: 5
min_confidence: 0.6
ignore_paths:
  - "examples/**"
  - "docs/**"
strict_paths:
  - "src/auth/**"
  - "src/payments/**"
```

Starting v0.3, auto-detection runs when no config exists. README mentions hackathon or WIP map to `prototype`. A configured CI workflow plus repo age over six months plus more than 500 commits map to `production`. Path matches auth or payments or crypto trigger `security_audit`.

## Onboarding flow (planned for v0.2)

The first review in a newly installed repository opens with this card once persona config ships.

```text
First review in this repo. Defaulting to the senior_engineer preset
(the same prompt v0.1 ships with: "senior software engineer").

To customize, add .cascade.yml to your repo root with one of these presets.
  prototype | production | mentor | security_audit | concise

Full config reference will live in the docs directory of this repository.
```

Subsequent reviews omit the card.

## Frontier scorecard

Honest classification of project components.

| Component | Class | Note |
|---|---|---|
| Webhook handler with HMAC | Commodity | Tutorial level |
| Single LLM call for review | Commodity | API integration |
| GitHub Reviews API inline comments | Commodity | Documented |
| Cascade routing | Standard pattern | OpenRouter and LiteLLM existed for years |
| LoRA distillation pipeline | Standard pattern | 2023 era technique |
| Format and safety sensors | Engineering depth | Most OSS bots skip |
| Langfuse observability with trace IDs | Engineering depth | Careful integration |
| Eval flywheel with weekly trace review | Engineering depth | Best practice rarely executed |
| Persona system with config and presets | Engineering depth | CodeRabbit has lighter version |
| Agentic tool use across four tools | Frontier-ish (in OSS) | No public OSS code review bot surveyed for this project publishes a four-tool agentic implementation. |
| Tool-based verification with calibrated confidence | Frontier | No commercial bot surveyed for this project publishes a tool-based verification layer over LLM findings. This is the differentiator. |
| Auto-detect persona from repo signals | Frontier-ish | Unimplemented in commercial bots |
| Adversarial robustness study (v0.5) | Frontier (research adjacent) | Active research topic at major AI safety teams |

Summary, with concrete numbers added after v0.3 ships measured data. PR Cascade aims to be a production-grade code review agent. The v0.3 release adds tool-based verification and targets a measured false-positive reduction against the v0.1 baseline.

## Risks and landmines

| Risk | Severity | Mitigation |
|---|---|---|
| Diff exceeds context window | Medium | Total patch character count is capped (`MAX_PROMPT_DIFF_CHARS = 200_000` in `src/webhook/handler.ts`). Reviews above the cap are skipped and logged. Per file chunking is a v0.2 candidate. |
| Webhook duplicate delivery | High | Idempotency map keyed on `X-GitHub-Delivery` with 24 hour TTL |
| GitHub App private key leak | Critical | Stored as Railway secret. Never in repo. Daily git history scan via gitleaks. Rotation plan if exposed |
| Bot posts hallucinated finding (line does not exist) | High | Validate every finding line is present in the diff before posting. v0.3 adds AST verification |
| OpenAI rate limit hit | Low | Rely on the SDK's retry semantics for transient 429 responses. Org-level rate and spend caps are the second line of defense. |
| Cost runaway from misconfiguration or unexpected traffic | Critical | Per-review cap enforced via `COST_CAP_CENTS_PER_REVIEW` (default $0.30). Per-repo and per-day caps planned in v0.2. |
| Review post fails after LLM cost incurred | Medium | A failed `postPullRequestReview` is logged as a `review.failed` trace event with the error message and duration. Cost and finding counts are captured only on the success path today. A pre-post `review.cost_settled` trace event is a v0.2 candidate. |
| Force push leaves stale inline comments | Low | GitHub auto marks them outdated. No action required |
| Persona config syntax error | Low | Strict Zod schema (planned with the v0.2 persona feature). Fall back to default and notify in review body. |
| Spam findings on docs only or generated files | Medium | Path filter in default persona (planned with the v0.2 persona feature). The current v0.1 prompt asks the model to skip trivial findings. |

## Success metrics

All metrics are aspirational targets. Verified after the corresponding version ships.

Quantitative targets.

- v0.1 processes real PRs across more than one repository
- v0.2 installations beyond personal repos
- v0.3 measurable false-positive reduction versus v0.1 baseline on a curated PR benchmark
- Per-review cost stays under the configured cap (default $0.30)

The roadmap deliberately omits star counts, install counts, and other vanity metrics. Concrete numbers go in technical writeups after measurement.

## External dependencies

The author must complete the following manual setup before the bot operates.

### GitHub App registration

1. Visit https://github.com/settings/apps/new
2. App name `pr-cascade-bot` (must be unique on GitHub)
3. Homepage URL https://github.com/zikunz/pr_review
4. Webhook URL is the Railway deployment URL plus `/github/webhook`
5. Webhook secret is a 32+ character random string, stored as `GITHUB_WEBHOOK_SECRET`
6. Repository permissions
   - Contents (read)
   - Metadata (read)
   - Pull requests (read and write)
   - Issues (read, required to subscribe to `issue_comment` events for the mention trigger)
   - Checks (read, for v0.2 CI log fetching)
7. Subscribed events
   - Pull request
   - Issue comment (for v0.1 mention triggers)
   - Check run (v0.2)
8. Generate private key, download as PEM, store as `GITHUB_APP_PRIVATE_KEY`
9. Note the App ID, store as `GITHUB_APP_ID`

### Railway setup

1. Sign up at https://railway.app
2. Connect GitHub account
3. Create new service from the pr_review repository main branch
4. Set environment variables from `.env.example`
5. Confirm the auto-generated deployment URL (Railway returns something like `pr-cascade-production.up.railway.app`)
6. Update the GitHub App webhook URL to match

### OpenAI

1. Confirm the OpenAI account has sufficient rate and spend limits for the expected webhook volume.
2. Set a monthly organization budget hard cap appropriate for the projected load. The per-review cap in this repo defaults to $0.30. The org-level cap is the second line of defense.
3. Generate an API key. Project keys with a model allowlist are recommended over organization keys.
4. Store the key as `OPENAI_API_KEY`.

## Glossary

**Cascade routing**. A system that selects among multiple LLMs based on input complexity, sending easy requests to cheap models and escalating hard requests to expensive models.

**Calibrated confidence**. A confidence score that accurately reflects probability of correctness. A finding marked confidence 0.8 should be correct approximately 80 percent of the time.

**HMAC SHA-256**. Hash based message authentication code using SHA-256. GitHub uses this to sign webhook payloads. Verification must be constant time to prevent timing attacks.

**Idempotency**. Property where running the same operation once or many times produces the same result. GitHub may redeliver webhooks. The bot tracks `X-GitHub-Delivery` headers to deduplicate.

**Inline comment**. A review comment attached to a specific diff line, as opposed to a top level PR comment.

**MCP**. Model Context Protocol. An open standard for connecting LLMs to external tools and data sources. The bot does not use MCP directly. The chat completions endpoint the bot uses does not consume MCP servers, and the OpenAI Responses API path is reserved for a future iteration. The bot replicates the same capability via OpenAI function calling.

**Persona**. A predefined configuration of review focus, tone, and thresholds, mapped to a specific system prompt.

**Prompt caching**. OpenAI feature where repeated portions of input prompts are charged at 10 percent of the standard input rate. Effective when the system prompt and few shot examples remain stable across calls.

**Structured output**. LLM API feature where the response is constrained to a JSON schema, validated by the provider before returning.

**Tool-based verification**. Pattern where LLM proposed findings are checked by deterministic tools (AST parser, symbol resolver, test coverage check) before being shown to the user.

**Tree-sitter**. Parser library with grammars for dozens of languages, producing concrete syntax trees. The bot uses it for AST inspection in v0.3.
