# Roadmap

Canonical product spec for PR Cascade. Last updated 2026-05-18.

## Identity

PR Cascade is a GitHub Pull Request review agent that demonstrates production engineering for LLM applications. It posts inline review comments, runs a model cascade for cost efficiency, and verifies LLM proposed findings against the source tree before posting.

## Why this exists

Most automated code review tools treat the model as a black box and ship a single hardcoded provider. PR Cascade goes the other direction. The routing logic, sensors, prompts, and verification approach are all visible source. The repository doubles as a working tool and a reference for the engineering patterns that separate a demo from a production LLM application.

Three ideas drive the design.

1. Verifiability over confidence. Every finding carries a calibrated confidence score, and the bot verifies each claim against the actual diff before posting it.
2. Cost discipline. Routine reviews stay on small open source models. Escalation to frontier models happens only when sensors fail or routing confidence is low. The full cost ledger is logged for every review.
3. Transparency. Prompts, eval methodology, and trace data formats are open so anyone can reproduce or critique the approach.

The bot is permanently free. The code, prompts, and trace format are public.

## Non-goals

This project explicitly does not do the following.

- Automatic PR approval. The bot only comments.
- Blocking merges. Required check status is never set.
- Modifying source code. The bot never pushes commits or opens PRs.
- Replacing human reviewers. The bot supplements human review.
- Cross platform support. GitHub only.
- Real time chat. Findings post once. The bot does not engage in PR threads.
- Multi agent collaboration. The system uses sequential cascade routing, not concurrent multi agent.
- Language specialization. The bot reviews any language the underlying model handles. No per language plugin system.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS | Railway hosting for v0.1 through v0.3 |
| Framework | Hono with `@hono/node-server` | Portable to Cloudflare Workers later with one entry file swap |
| Language | TypeScript strict | No `any` without justification |
| LLM (v0.1) | `gpt-5.3-codex` via OpenAI API | Verify current pricing at platform.openai.com before committing cost estimates |
| LLM (v0.2 cascade) | Tier 1 `gpt-5.4-mini`, Tier 2 `gpt-5.3-codex`, Tier 3 `gpt-5.5` advisor | All OpenAI for v0.2. Multi provider cascade becomes a v0.4+ exploration |
| Auth | GitHub App with JWT signed installation tokens | Standard pattern |
| Lint and format | Biome 2.x | Single tool |
| Test | Vitest 4.x | |
| CI | GitHub Actions | Typecheck, lint, test, gitleaks secret scan |
| Observability (v0.2+) | Langfuse cloud free tier initially | Self host for v0.3 |
| Package manager | npm | pnpm 11 strict build approval blocks CI |

Migration to Cloudflare Workers happens in v0.4 once Cloudflare for Startups credits land. Architecture is designed to allow this with minimal changes (Hono is universal, business logic does not depend on Node specifics).

## Architecture (v0.1)

```
GitHub PR opened or synced
        │
        ▼
POST /github/webhook
        │
        ▼
verify HMAC SHA-256 in constant time
        │
        ▼
idempotency check on X-GitHub-Delivery
        │
        ▼
return 200 within 5s
        │
        ▼
async pipeline
        │
   ┌────┴────┐
   │ fetch    │  GitHub App JWT → installation token → PR data, files, diff
   │ analyze  │  build prompt → gpt-5.3-codex with response_format → Zod parse
   │ validate │  verify every finding line exists in diff
   │ post     │  Reviews API with line+side inline comments
   │ log      │  cost, duration, finding count to local trace file
   └─────────┘
```

## Version roadmap

Milestones are ordered, not scheduled. Each version is shippable on its own.

| Version | Theme |
|---|---|
| v0.1 | Single model end to end on Railway |
| v0.2 | Cascade plus agentic tools plus persona system |
| v0.3 | Tool based verification with calibrated confidence |
| v0.4 | LoRA distillation and Cloudflare Workers migration |
| v0.5+ | Adversarial robustness and online learning |

### v0.1 scope

The smallest viable end to end pipeline.

In scope.

- Webhook reception with HMAC verification and idempotency
- GitHub App installation token authentication
- Fetch PR metadata, files, and diff
- Single `gpt-5.3-codex` call per review with structured JSON output
- Single hardcoded persona named balanced senior engineer
- PR Review with inline comments via `line` plus `side` API
- Per review cost cap at $0.30 hard fail
- Idempotency via in memory map keyed by delivery ID, 24 hour TTL
- Local file logging for traces
- Triggers on `pull_request.opened`, `synchronize`, `reopened`
- Manual re-trigger on `issue_comment.created` when the comment body contains the bot mention pattern (`@<bot-name> review`)
- Deploy to Railway with `/health` endpoint

Not in v0.1. Cascade, persona config, auto detection, agentic tools, repository wide context, verification, eval pipeline, frontend dashboard.

### v0.2 scope

Adds production sense and configurability. Reuses v0.1 plumbing.

New capabilities.

1. **Cascade routing** across three tiers driven by complexity heuristics. Tier 1 handles small diffs and docs only changes. Tier 2 handles ordinary code changes. Tier 3 escalates only on sensor failure or low confidence.
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

The frontier piece. Tool based verification with calibrated confidence.

This is what differentiates the project from commercial bots and the only component that is genuinely frontier in 2026.

New capabilities.

1. **AST parsing** via `tree-sitter`. For each finding, verify that the referenced line is the type of construct the LLM claims (function call, null deref, etc.).
2. **Cross file symbol resolution** via lightweight import graph. Detect findings that reference non existent functions, classes, or types.
3. **Control flow heuristic**. Scan 30 lines preceding a proposed null deref for null guards. Detect optional chaining (`?.`), nullish coalescing, type narrowing patterns.
4. **Test coverage signal**. Findings on lines exercised by tests get a confidence penalty.
5. **Confidence aggregation**. Combine LLM stated confidence with verification evidence into final score. Findings below threshold (default 0.5) drop. Findings above 0.85 always post. Mid range tagged for human attention.
6. **Auto detect persona** when no `.cascade.yml` exists. Signals are README content, CI presence, repo age, sensitive path patterns.
7. **Per PR override** via PR label (`cascade:lenient`, `cascade:strict`) or description hint.
8. Eval metrics dashboard for review of aggregate accuracy and cost trends across repos. Surface is internal first, public later when the data justifies it.

Target outcome. The v0.1 production traces establish the baseline false positive rate. v0.3 verification aims to cut it by at least half. Precise numbers go in the v0.3 ship blog after measurement, not in this roadmap.

### v0.4 and beyond

Not committed. Listed for direction.

- LoRA distillation from `gpt-5.3-codex` to Mistral 7B Instruct v0.2 on Cloudflare Workers AI
- Migration of full stack to Cloudflare Workers when Startups credits arrive
- Adversarial robustness study with prompt injection PR corpus and defensive sensor
- Cross codebase pattern recognition via vector database of historical PR outcomes
- Verified execution via sandboxed test runs

## Personas and config

The default persona for v0.1 is balanced senior engineer.

```
Focus     bugs, security, performance, API misuse
Ignore    style, naming, subjective architecture choices
Tone      direct and constructive
Findings  maximum 5 per review
Threshold confidence 0.6 minimum to post
```

Starting v0.2, users override via `.cascade.yml` in repo root.

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

Starting v0.3, auto detection runs when no config exists. README mentions hackathon or WIP map to `prototype`. Comprehensive CI plus repo age greater than six months plus more than 500 commits map to `production`. Path matches auth or payments or crypto trigger `security_audit`.

## Onboarding flow

The first review in a newly installed repository opens with this card.

```
First review in this repo. Defaulting to senior_engineer persona.

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
| Agentic tool use across four tools | Frontier-ish (in OSS) | Cursor uses internally, no public OSS implementation |
| **Tool based verification with calibrated confidence** | **Frontier** | No commercial bot publishes this. The differentiator. |
| Auto detect persona from repo signals | Frontier-ish | Unimplemented in commercial bots |
| Adversarial robustness study (v0.5) | Frontier (research adjacent) | Active research topic at major AI safety teams |

Project pitch (numbers filled in after v0.3 ships with measured data). PR Cascade is a production code review agent with tool based verification that materially reduces LLM false positive rate, open sourced as a reference implementation.

## Risks and landmines

| Risk | Severity | Mitigation |
|---|---|---|
| Diff exceeds context window | Medium | Chunk by file. Skip review if total exceeds 100K tokens. Tell user to split PR |
| Webhook duplicate delivery | High | Idempotency map keyed on `X-GitHub-Delivery` with 24 hour TTL |
| GitHub App private key leak | Critical | Stored as Railway secret. Never in repo. Daily git history scan via gitleaks. Rotation plan if exposed |
| Bot posts hallucinated finding (line does not exist) | High | Validate every finding line is present in the diff before posting. v0.3 adds AST verification |
| OpenAI rate limit hit | Low | Exponential backoff. Tier 5 limits far exceed projected load |
| Cost runaway from infinite loop | Critical | Per repo daily cost cap. Hard kill switch via env var. Per review hard cap $0.30 |
| Review post fails after LLM cost incurred | Medium | Log finding to retry queue. Idempotent retry by storing parsed output |
| Force push leaves stale inline comments | Low | GitHub auto marks them outdated. No action required |
| Persona config syntax error | Low | Strict Zod schema. Fall back to default and notify in review body |
| Spam findings on docs only or generated files | Medium | File path filter in default persona. Ignore lock files and generated outputs |

## Success metrics

All metrics are aspirational targets. Verified after the corresponding version ships.

Quantitative targets.

- v0.1 processes real PRs across more than one repository
- v0.2 installations beyond personal repos
- v0.3 measurable false positive reduction versus v0.1 baseline on a curated PR benchmark
- Per review cost stays under the configured cap (default $0.30)

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
   - Issues (read and write, for mention triggers in v0.1)
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
5. Confirm the auto generated deployment URL (e.g., pr-cascade.up.railway.app)
6. Update the GitHub App webhook URL to match

### OpenAI

1. Confirm Tier 5 access (already verified)
2. Set monthly organization budget hard cap to $25
3. Generate API key restricted to chat completions scope
4. Store as `OPENAI_API_KEY`

## Glossary

**Cascade routing**. A system that selects among multiple LLMs based on input complexity, sending easy requests to cheap models and escalating hard requests to expensive models.

**Calibrated confidence**. A confidence score that accurately reflects probability of correctness. A finding marked confidence 0.8 should be correct approximately 80 percent of the time.

**HMAC SHA-256**. Hash based message authentication code using SHA-256. GitHub uses this to sign webhook payloads. Verification must be constant time to prevent timing attacks.

**Idempotency**. Property where running the same operation once or many times produces the same result. GitHub may redeliver webhooks. The bot tracks `X-GitHub-Delivery` headers to deduplicate.

**Inline comment**. A review comment attached to a specific diff line, as opposed to a top level PR comment.

**MCP**. Model Context Protocol. An open standard for connecting LLMs to external tools and data sources. The bot does not use MCP directly because OpenAI does not support it natively. The bot replicates the same capability via OpenAI function calling.

**Persona**. A predefined configuration of review focus, tone, and thresholds, mapped to a specific system prompt.

**Prompt caching**. OpenAI feature where repeated portions of input prompts are charged at 10 percent of the standard input rate. Effective when the system prompt and few shot examples remain stable across calls.

**Structured output**. LLM API feature where the response is constrained to a JSON schema, validated by the provider before returning.

**Tool based verification**. Pattern where LLM proposed findings are checked by deterministic tools (AST parser, symbol resolver, test coverage check) before being shown to the user.

**Tree-sitter**. Parser library covering 80+ languages, producing concrete syntax trees. The bot uses it for AST inspection in v0.3.
