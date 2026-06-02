# Evaluation

## Summary

| Experiment | Key result |
|---|---|
| Noise panel, 22 merged PRs, deployed model | 26 findings, nearly all false positives including 3 confident criticals |
| Noise panel, stronger same-vendor models | gpt-5.3-codex: 5 findings; gpt-5.5: 6 findings |
| Recall test, 8 planted bugs, 3 models | 8/8 caught by every model (diff-anchored fixtures) |
| Verification layer over mini's 26 findings | 24 removed, 2 kept, 0 split (92% of mini's findings) |
| Recall preservation through verifier | 8/8 real bugs kept |
| Cross-vendor compatibility (2 models) | `gemini-3.1-pro-preview`: 9 findings, 20/22 PRs completed (2 incomplete-output errors); `claude-opus-4.8`: 0/22 PRs completed (provider-routing 404 on all 22) |

The deployed model (gpt-5.4-mini) has 100% recall on planted, diff-evident bugs and high noise on accepted code. gpt-5.5 and gpt-5.3-codex had the same recall and posted far fewer findings on the same PRs. Over mini's 26 findings on this dataset, a refutation-first verification gate removed 24 while preserving all 8 planted-bug catches.

---

## Dataset

22 merged pull requests drawn from four repositories.

| Repository | PRs |
|---|---|
| [facebook/react](https://github.com/facebook/react) | 6 |
| [fastapi/fastapi](https://github.com/fastapi/fastapi) | 4 |
| [spring-projects/spring-boot](https://github.com/spring-projects/spring-boot) | 6 |
| [axios/axios](https://github.com/axios/axios) | 6 |

Candidates were filtered to code-extension files with at least one non-test file, a total code-file patch between 200 and 40,000 characters, and at least one line eligible for a diff-anchored comment. The qualifying PRs were sorted by creation date, most recent first, and frozen to `eval/eval-prs.json` for reproducibility.

---

## Scoring rubric

A finding is a **true positive** if it is worth posting to the author as written, judged against the actual code.

Common false positive tags include `hallucination` (factually wrong reading of the code), `already-handled` (concern is addressed in the same diff), `overstated` (real pattern but consequence is wrong), `low-value` (style or trivia), and `subjective` (preference with no correctness argument).

Labels are based on reading the code. No model is used to generate labels.

---

## Experiment 1: Cross-model noise panel

Each model received the same 22 PRs through the bot's exact review path. The prompt, output schema, and diff-anchoring validation gate were identical across all runs. No webhooks or live GitHub traffic.

| Model | Findings posted | PRs completed |
|---|---|---|
| openai/gpt-5.4-mini | 26 | 22 / 22 |
| openai/gpt-5.5 | 6 | 22 / 22 |
| openai/gpt-5.3-codex | 5 | 22 / 22 |
| google/gemini-3.1-pro-preview | 9 | 20 / 22 |
| anthropic/claude-opus-4.8 | 0 | 0 / 22 |

The `google/gemini-3.1-pro-preview` model failed on 2 of 22 PRs with truncated or incomplete output, one of which hit the output-length limit. The `anthropic/claude-opus-4.8` model returned the same provider-routing 404 on all 22 PRs and produced no results. The bot's request for a strict `json_schema` response format is the most likely trigger of the failure, though the 404 is a generic routing error that was not isolated to one parameter. The noise comparison is therefore based on the three gpt-5.x models, which all ran on the full set without errors.

Mini's 26 findings included three critical findings at confidence 0.96–0.98, all false positives. One (0.98, axios PR) claimed a config-merge helper passed a boolean presence check rather than the actual value to a URL builder, breaking query-string serialization. Reading the code confirmed the helper returns the value. A second (0.96, Spring PR) flagged a nested-property dereference as a null-pointer risk, but the Spring property holder is always initialized, so the removed null check was redundant. The third (0.98, React PR) correctly saw that two exports were dropped from an internal, experimental React package, but over-weighted that expected churn as a critical breaking change.

---

## Experiment 2: Recall test

Eight small diffs, each containing one planted, diff-evident bug. All three models were run over these fixtures using the same review path.

| Fixture | Planted bug |
|---|---|
| `sql-injection` | `req.query.orderId` interpolated directly into a SQL string |
| `command-injection` | `req.query.path` concatenated into a shell command passed to `exec` |
| `path-traversal` | `req.query.file` used in `readFileSync` path without sanitization |
| `off-by-one` | loop condition `i <= items.length` reads one past the last element |
| `assignment-in-condition` | `if (user.role = 'admin')` assigns instead of comparing |
| `hardcoded-secret` | live Stripe key (`sk_live_...`) committed in source |
| `weak-random-token` | `Math.random()` used to generate a password reset token |
| `empty-catch-swallow` | `gateway.charge` exceptions swallowed in empty catch; checkout always returns success |

| Model | Bugs caught | Recall |
|---|---|---|
| openai/gpt-5.4-mini | 8 / 8 | 100% |
| openai/gpt-5.5 | 8 / 8 | 100% |
| openai/gpt-5.3-codex | 8 / 8 | 100% |

---

## Experiment 3: Verification layer

A refutation-first verifier panel (gpt-5.5 and gpt-5.3-codex) was run over mini's findings. Each verifier received the finding text and the relevant diff. The instruction defaults to `false_positive` unless the diff itself confirms the issue.

**Mini's panel findings (26)**

| Outcome | Count |
|---|---|
| Both verifiers: `false_positive` (removed) | 24 |
| Both verifiers: `real` (kept) | 2 |
| Split | 0 |

All three high-confidence critical false positives were removed with diff-grounded reasons.

**Planted-bug catches (8)**

| Outcome | Count |
|---|---|
| Both verifiers: `real` (kept) | 8 / 8 |
| Killed | 0 / 8 |

The verifier removed 24 of mini's 26 findings (92%) and kept all 8 planted-bug catches (8 / 8).

---

## Conclusion

Recall was not the differentiator. All three models caught every planted, diff-evident bug. The difference was precision on accepted code. Mini posted 26 findings on merged PRs, nearly all of them false positives, including three confident criticals that should not have been posted. gpt-5.5 and gpt-5.3-codex posted 5–6 on the same PRs.

A refutation-first verification gate addresses this asymmetry. It removes findings the diff does not support and keeps findings the diff confirms. Run over mini's output, it removed 24 of the 26 findings while preserving every planted-bug catch, at the cost of two verifier calls per finding that reaches the gate.

---

## Limitations

- **Recall scope.** Recall was measured on planted, diff-evident bugs. A finding was counted as a catch if it was anchored to a valid diff line within the planted fixture's file. The pipeline did not verify that the finding described the planted bug or require any particular severity. Recall on subtle, cross-file, or semantic bugs is untested and would require a labeled dataset of known real regressions.
- **Sample size and selection.** The noise measurement covers 22 merged PRs drawn as the most recent qualifying PRs from four high-profile, heavily reviewed repositories, a selection that likely understates false positive rates on lower-quality or internal code. At 22 PRs this is a method demonstration, not a precise rate.
- **Scoring scope.** The stronger models' findings were counted, not individually scored for precision.
- **Same-vendor coverage.** The clean noise comparison and the verifier cover same-vendor models only. Same-vendor verifiers may share systematic failure modes with the base model, which could inflate apparent precision. Cross-vendor coverage remains future work, since the two cross-vendor models did not complete the panel cleanly in this run.
- **Labeling.** Labels are the author's judgments against the code, with no second coder.

---

## How to reproduce

```bash
# Freeze PRs — uses gh CLI auth (gh auth login), no OPENAI_API_KEY needed for this step
npx tsx eval/eval-replay.ts --select

# Run a model — requires OPENAI_API_KEY and OPENAI_BASE_URL in .env.local
npx tsx eval/eval-replay.ts --model openai/gpt-5.4-mini

# Run the verification layer over mini's results
npx tsx eval/eval-verify.ts

# Run the recall fixtures
npx tsx eval/eval-recall.ts

# Run recall preservation
npx tsx eval/eval-recall-verify.ts
```

Results are written to `eval/eval-results-<model>.jsonl`, `eval/eval-verify-results.jsonl`, and `eval/eval-recall-results.jsonl`. Recall preservation output is printed to stdout.
