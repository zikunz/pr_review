# Evaluation

## Summary

| Experiment | Key result |
|---|---|
| Noise panel, 22 merged PRs, deployed model | 26 findings, nearly all false positives including 3 confident criticals |
| Noise panel, stronger same-vendor models | gpt-5.3-codex: 5 findings; gpt-5.5: 6 findings |
| Recall test, 8 planted bugs, 3 models | 8/8 caught by every model (diff-anchored fixtures) |
| Verification layer over mini's 26 findings | 24 removed, 2 kept, 0 split (92% of mini's findings) |
| Recall preservation through verifier | 8/8 real bugs kept |
| Cross-vendor compatibility (2 models) | `gemini-3.1-pro-preview`: 9 findings, 20/22 PRs completed (2 incomplete-output errors); `claude-opus-4.8`: 0/22 as a generator (provider error; completes the smaller verifier schema, Experiment 6) |
| Grounding (full-file context) over the deployed model | No noise reduction: 26 → 28 findings, 3 → 5 critical findings; the flagship 0.98 false positive recurred in 4/4 grounded runs |
| Cross-file recall, 5 planted fixtures, full dependency in context | Grounding helped on 3 of 5 (hand-verified recall 1/15 → 8/15); the other 2 were missed even with the dependency in context |
| Cross-vendor verification over mini's 26 findings | Gemini 3.1 Pro killed 25/26, Opus 4.8 killed 23/26, both agreeing with the same-vendor panel on 23 to 25 of 26 |
| Multi-agent review (planner, reviewer, critic) on gpt-5.5 | 9 findings vs 6 for single-pass, recall 8/8 preserved; more thorough, not more precise |
| Per-finding precision audit, all 83 findings | 1 clear true positive, roughly 80 false positives; every finding at confidence 0.95+ was wrong |
| Verification gate over all 83 findings | dropped 67 of 79 false positives (85%); kept the real bug (2 of its 3 detections) |
| Confidence calibration, all 83 findings | mean confidence 0.80 vs actual accuracy 0.036; ECE 0.76, Brier 0.63; the 13 findings at 0.95+ were all wrong |
| Agentic (tool-using) gate over mini's 26 findings | read real source on all 26 (190 reads), dropped 25 vs the static panel's 24, refuting one false positive the static gate kept; it still dropped the vague real-bug detection |
| Agentic gate across three vendors | gpt-5.5, Opus 4.8, and Gemini 3.1 Pro each read real source on all 26 findings and dropped 24 to 25, keeping the same one finding; the agentic gain is not OpenAI-specific |
| One-click fix suggestions, 8 planted bugs | the bot offered a fix on 7 of 8 (a correct abstention on the 8th) and 6 of the 7 fixes are correct; one over-eager wrong suggestion on a multi-line fix |
| PR walkthrough quality, 7-PR sample | every changed file described on 7 of 7 PRs; 18 of 20 items accurate, 2 hallucinated a file not in the diff (a changelog, a typings file) |
| Large-scale precision, 200 PRs / 19 repos / 6 languages | judge-scored false-positive rate 90% (95% CI 85-93%), a calibrated lower bound; the 22-PR noise result holds across the ecosystem |

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

The `google/gemini-3.1-pro-preview` model failed on 2 of 22 PRs with truncated or incomplete output, one of which hit the output-length limit. The `anthropic/claude-opus-4.8` model returned the same provider-routing 404 on all 22 PRs and produced no results. Experiment 6 isolates the cause. The same model completed all 26 calls with the smaller verifier `json_schema`, while the larger review-output schema failed on every attempt, so the strict review-output schema is the obstacle rather than the model being unavailable. The noise comparison is therefore based on the three gpt-5.x models, which all ran on the full set without errors.

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

A refutation-first verifier panel (gpt-5.5 and gpt-5.3-codex) was run over mini's findings. Each verifier received the finding text and the relevant diff. The instruction defaults to `false_positive` unless the diff itself confirms the issue. This experiment used a two-model panel to exercise the consensus rule. The shipped gate defaults to a single verifier (`VERIFY_MODELS=gpt-5.5`), a strict subset of the panel measured here.

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

## Experiment 4: Does grounding replace the verification gate?

The three confident false positives in Experiment 1 all came from diff-only reasoning. The disambiguating code lived outside the diff: the axios `own` helper's definition, the Spring property's field initializer, and the React package's `private` status. The frontier best practice for this, used by tools like Greptile and CodeRabbit and described as "grounding" in recent work, is to review with the surrounding code rather than the diff alone. This experiment tests whether grounding the deployed model in the full file removes those false positives, which would make a verification gate unnecessary.

The 22 PRs were re-reviewed by gpt-5.4-mini with the full current content of each changed file (fetched at the PR head, capped per file) appended to the otherwise-identical prompt. The system prompt, output schema, and diff-anchor gate were unchanged, so the only variable is the added context. As a robustness check against sampling noise, the flagship axios PR was re-run four times under grounding.

| Metric | Diff-only (baseline) | Full-file (grounded) |
|---|---|---|
| Total findings | 26 | 28 |
| Critical findings | 3 | 5 |
| axios `resolveConfig.js:59` false positive | present (0.98) | present in 4/4 runs (0.98, 0.79, 0.99, 0.99) |

Grounding did not reduce the model's output. The flagship axios false positive recurred in all four grounded runs at high confidence, even though the `own` helper's definition was confirmed present in the supplied file. Each run produced a confident and still-incorrect reading of the same line. The Spring and React baseline criticals did not recur in the single grounded run, but new criticals appeared on other PRs, and each condition is a single full run, so the disappearance is within run-to-run variance rather than a clean attribution to grounding.

Full-file context, a superset of what retrieval-based tools surface, was necessary but not sufficient. It did not fix the most confident hallucination, and the critical-severity count rose from 3 to 5. Grounding does not obviate the verification gate. The two are complementary, and the gate in Experiment 3 is the component measured to remove the false positives. The bottleneck for these errors is the model's reasoning and confidence calibration on the diff, not the availability of context.

---

## Experiment 5: Does cross-file context improve recall?

Experiment 4 tested grounding on the precision axis (same-file false positives) and found it did not help. This experiment tests the other axis, the one that motivates retrieval-based tools like Greptile. That axis is recall on bugs whose root cause lives in a file the diff does not touch.

Five planted fixtures, each with a changed file (the diff) and an unchanged dependency. The bug sits on a changed line but is only detectable by reading the dependency: a call that passes the wrong number of arguments against the dependency's signature, an inverted use of a return contract (a validator that returns null when valid), an import of a symbol the dependency does not export, a unit mismatch against a documented parameter (milliseconds where seconds are expected), and a missing null check against a nullable return. gpt-5.4-mini reviewed each fixture under two conditions, three runs each: diff-only (the changed file alone, the bot's default) and grounded (the changed file plus the dependency's full content). A catch is a finding anchored to the changed line. Each catch was then checked by hand against the planted bug.

| Fixture | diff-only | grounded |
|---|---|---|
| `inverted-return-contract` | 0 / 3 | 3 / 3 |
| `missing-export` | 0 / 3 | 3 / 3 |
| `null-contract` | 1 / 3 | 2 / 3 |
| `wrong-arg-count` | 0 / 3 | 0 / 3 |
| `unit-mismatch` | 0 / 3 | 0 / 3 |
| **Hand-verified total** | **1 / 15** | **8 / 15** |

The raw anchored-finding count was 5/15 diff-only and 8/15 grounded. The diff-only figure overcounts, because the model often posted a hedged question or a comment about a different concern on the changed line, and the location-only filter accepts those. The table counts only findings that describe the planted bug, the same hand-judged criterion as Experiment 2.

Grounding helped on three of the five bugs. Where the dependency stated an explicit contract that the model read (a null-on-valid return, a single exported symbol, a nullable return), the grounded model identified the bug that the diff-only model could not. On the other two (a wrong argument count against the dependency's signature, and a milliseconds-for-seconds unit mismatch) the grounded model missed the bug in all three runs even though the relevant signature was in its context.

So cross-file context improved recall, but only where the model actually used the contract in front of it. Combined with Experiment 4, the pattern is consistent across both axes. The bottleneck is the model's use of available context, not the availability of context. That is why context-grounding and the verification gate are complementary rather than competing. Grounding determines what the model can see, and the gate compensates for what the model does with it.

---

## Experiment 6: Does the verification gate work across vendors?

Experiment 3 ran the gate with a same-vendor verifier panel (gpt-5.5 and gpt-5.3-codex). The Limitations section flags this risk. A verifier from the same family as the base model may share its blind spots, which could inflate the apparent precision gain. This experiment re-runs the gate over the same 26 findings mini posted, replacing the verifier with a cross-vendor model. Each verifier judged all 26 findings from the diff alone, with the same refutation-first instruction as Experiment 3.

| Verifier | Vendor | Killed (false positive) | Agreed with same-vendor panel | mini's 3 confident criticals |
|---|---|---|---|---|
| gpt-5.5 + gpt-5.3-codex (baseline) | OpenAI | 24 / 26 | reference | all 3 killed |
| gemini-3.1-pro-preview | Google | 25 / 26 | 25 / 26 | all 3 killed |
| claude-opus-4.8 | Anthropic | 23 / 26 | 23 / 26 | 2 killed, 1 kept |

All three independent verifiers, spanning three vendors, removed the bulk of mini's noise (23 to 25 of 26). The gate's noise reduction is therefore not an artifact of a same-vendor verifier sharing the base model's failure modes.

The verifiers were not identical on the hard cases. Opus judged the axios `resolveConfig.js:59` false positive (confidence 0.98) as real, the one finding Experiment 4 showed requires code outside the diff to refute. A verifier that reads only the diff can be fooled by it, which is consistent with the cross-file result that the bottleneck is the use of context, not the verifier's vendor. Under the gate's unanimous-false-positive rule a multi-vendor panel keeps this finding, since one real vote blocks the drop, which is the conservative fail-open behavior the gate already uses.

Cost was negligible. The Gemini run cost $0.36 and the Opus run cost $0.38 over the 26 findings, at OpenRouter prices verified on 2026-06-02 (Gemini 3.1 Pro at $2 and $12 per million input and output tokens, Opus 4.8 at $5 and $25). Opus failed to generate a full review in Experiment 1 (0 of 22, a provider error) but completed all 26 calls as a verifier here. Since the only difference is the smaller verdict schema, the strict review-output `json_schema` is the obstacle, not the model being unavailable.

---

## Experiment 7: Does multi-agent collaboration beat a single pass?

The bot reviews a PR in one model call. A natural v0.3 question is whether a multi-agent collaboration on the same strong base model does better. This experiment runs a three-stage pipeline on gpt-5.5 over the same 22 PRs. A planner emits a focused review plan, a reviewer produces candidate findings from the diff and the plan, and a critic returns the final findings, dropping what the diff does not confirm. The final findings pass the same diff-anchor gate. The baseline is single-pass gpt-5.5 from Experiment 1.

| Pipeline | Findings on the 22 PRs | Real findings (hand-scored) | Planted-bug recall |
|---|---|---|---|
| Single-pass gpt-5.5 (Experiment 1) | 6 | 0 clear, 1 borderline | 8 / 8 |
| Multi-agent gpt-5.5 (planner, reviewer, critic) | 9 | 1 clear, 0 borderline | 8 / 8 |

The reviewer produced 18 candidate findings and the critic pruned them to 9. The collaboration increased finding volume rather than reducing it. Recall was preserved, since the critic kept all eight planted bugs. On the per-finding hand review (Experiment 8), the multi-agent pipeline surfaced exactly one clear real bug, the same React control-flow defect the deployed model also found, and its other findings were false positives.

So multi-agent collaboration found the same single real bug the cheap model did and added false positives, not real ones. On merged, accepted code, where the precision-optimal output is few findings, posting 50 percent more than the single pass is the wrong direction. This is the opposite of the verification gate (Experiments 3 and 6), which reduces volume. For a bottleneck that is precision, not recall, the gate is the better-targeted intervention, which is why the bot ships the gate and not this pipeline. The run cost $3.78 at OpenRouter prices, $3.42 for the precision arm and $0.36 for the recall arm.

---

## Experiment 8: Per-finding precision across every configuration

Experiments 1 to 7 counted findings and scored a sample (the three confident criticals, the planted bugs, the verifier panel). This experiment hand-scores every finding the six configurations posted on the 22 merged PRs, against the actual code, to measure precision directly rather than infer it from the verification gate. The per-finding verdicts and the method are in [`eval/finding-scores.md`](../eval/finding-scores.md).

83 findings were scored: the noise panel (mini 26, gpt-5.5 6, gpt-5.3-codex 5, gemini 9, opus 0), the grounding re-review (28), and the multi-agent pipeline (9).

| Configuration | Findings | Clear true positive | Borderline | False positive |
|---|---|---|---|---|
| gpt-5.4-mini (deployed) | 26 | 1 | 0 | 25 |
| gpt-5.5 | 6 | 0 | 1 | 5 |
| gpt-5.3-codex | 5 | 0 | 0 | 5 |
| gemini-3.1-pro-preview | 9 | 1 | 0 | 8 |
| grounded-mini | 28 | 0 | 0 | 28 |
| multi-agent gpt-5.5 | 9 | 1 | 0 | 8 |

Across all 83 findings there was exactly one clear true positive, a control-flow bug in React PR 36566 that masks a decode error, surfaced independently by gpt-5.4-mini, gemini-3.1-pro, and the multi-agent pipeline. One further finding is genuinely borderline, an axios redirect-credential hardening gap that leans real. Every other finding, roughly 80 of 83, was a false positive, including a FastAPI latent asset-staging gap that leans borderline but whose harm is never realized in the repository.

Every finding at confidence 0.95 or above was a false positive, including one at 1.00 (gemini) and mini's confident criticals at 0.96 to 0.98. The one clear true positive carried confidences of 0.73 to 0.90. High model confidence did not track correctness on this set.

This is the strongest form of the central result. Recall was never the problem. Every configuration caught the planted bugs. Precision was the problem, and it stayed low even for the frontier models, even with full-file grounding, and even with a multi-agent pipeline. A verification gate that removes unconfirmed findings is the intervention that targets this directly. Some verdicts rest on source outside the frozen diff (a helper, a build file, a pinned library version), resolved against the real merged code the same way Experiment 4 was, and the borderline calls are flagged rather than rounded.

---

## Experiment 9: The gate against the full hand-scored set

Experiment 8 produced a per-finding ground truth. This experiment runs the shipped verification gate (the production verifier, gpt-5.5, refutation-first) over all 83 findings and measures it against that ground truth rather than against itself.

| Measure | Result |
|---|---|
| False positives dropped by the gate | 67 of 79 (85%) |
| Clear true positive | preserved, kept by 2 of its 3 detections |
| Borderline finding | dropped |

The gate removed 85 percent of the false positives across all six configurations, not just the cheap model it was tuned against. That is the core claim made concrete. A refutation-first gate is a general precision filter, not a tweak that only helps the cheap model.

The result is honest about two limits. The gate kept 12 false positives, so it is a strong filter, not a perfect one. And the one real bug was found by three configurations, of which the gate kept the two precisely worded detections (gemini and the multi-agent pipeline) and dropped the third, mini's vaguer description at 0.73 confidence that the verifier could not confirm from the wording. So the gate preserved the bug, but its recall on a real finding depends on how clearly that finding is stated. This is the cost of a refutation-first rule, and it is why the gate fails open on any single confirmation rather than requiring all of them.

---

## Experiment 10: Is the model's confidence calibrated?

Every finding carries a self-reported confidence, and Experiment 8 gives a hand label for each. This experiment measures how well the confidence tracks correctness, the standard way a probabilistic classifier is judged. A finding counts as correct when it is a genuine, worth-posting issue (a true positive). The script is `eval/calibration.ts` and the result is `eval/eval-calibration.json`.

| Self-reported confidence | Findings | Mean confidence | Actual accuracy |
|---|---|---|---|
| 0.95 to 1.00 | 13 | 0.965 | 0.000 |
| 0.90 to 0.95 | 8 | 0.910 | 0.125 |
| 0.80 to 0.90 | 22 | 0.844 | 0.045 |
| 0.70 to 0.80 | 22 | 0.756 | 0.045 |
| below 0.70 | 18 | 0.631 | 0.000 |

![Reliability diagram over the 83 findings. The model self-reported confidence runs along the x-axis and the actual fraction of real findings along the y-axis. A calibrated model would track the dashed diagonal, but observed accuracy stays near zero across the whole range and the gap to the diagonal is widest at the highest confidence.](./reliability.svg)

The model's mean self-reported confidence is 0.80. Its actual accuracy is 0.036. That is an overconfidence gap of 0.76, an Expected Calibration Error of 0.76, and a Brier score of 0.63, where 0 is perfect. The 13 findings the model was most sure about, at 0.95 and above, were wrong every time. Accuracy did not rise with confidence. It stayed near zero across the whole range.

This is the precision result restated as a calibration failure. The confidence number carries almost no information about whether a finding is real, so a downstream tool cannot threshold on confidence to filter noise. Re-judging each finding against the diff is the alternative, and Experiment 9 measured the gate removing 85 percent of the false positives. Counting the one borderline finding as correct does not change the picture (accuracy 0.048, Expected Calibration Error 0.75).

---

## Experiment 11: Does a tool-using verifier beat the static gate?

The static gate (Experiment 3) and full-file grounding (Experiment 4) both judge a finding without reading the wider codebase, and Experiment 6 left one false positive standing because its refutation lived outside the diff. This experiment runs the shipping agentic verifier (`src/openai/verify-tools.ts`, the gate behind `VERIFY_TOOLS_ENABLED`) over the same 26 findings the deployed model posted. The verifier can call `find_files` and `read_file` to inspect the real repository at each pull request head commit before it decides, so it can look up the definition a finding depends on instead of judging from the description. The loop, tools, and refutation-first rule are the production code. Only the model call and the file fetcher are supplied by the harness. The verifier was gpt-5.5 with up to eight tool-calling turns per finding.

| Measure | Static gate (Experiment 3 panel) | Agentic gate (gpt-5.5 with tools) |
|---|---|---|
| Findings dropped (of 26) | 24 | 25 |
| Findings where it read real source | 0 | 26 |
| Tool calls made | 0 | 190 (about 7 per finding) |

The agentic verifier read real source on every one of the 26 findings, 190 reads in total. It dropped 25, comparable to the two-model static panel's 24. The one finding it dropped that the static panel had kept is a FastAPI false positive about non-translated documentation assets, and reading the staging script confirmed the concern did not hold, a refutation the diff alone did not support. So giving the verifier the real code did let it refute a false positive the static gate left standing.

It is not a clean win. The agentic gate kept one finding as real that the per-finding audit (Experiment 8) scored a false positive, a claimed Windows path-separator mismatch in the same FastAPI script, after reading the two functions involved. Whether that is a latent cross-platform bug or a harm never realized is itself a borderline call, which is why that pull request supplied the audit's borderline findings. And on the one real bug, the React control-flow defect, the agentic verifier read the actual flush control flow and still scored the deployed model's vaguely worded detection (confidence 0.73) a false positive, exactly as the static gate did. Reading the real code does not rescue a finding whose description is too vague to confirm.

The honest reading is that for diff-anchored findings on merged pull requests, the false positives were largely refutable from the diff already, so the agentic gate mostly confirms the static gate's verdicts with better-grounded reasons (it read the real `isURLSameOrigin` helper, the real flight-server internals) rather than overturning them. The gain is a refutation grounded in the actual code and one fewer surviving false positive, at a real cost of about seven model turns and eight cents per finding against one turn for the static gate. The full run cost $2.05 at OpenRouter prices. One pull request, axios #10901, no longer resolves on the GitHub API, so its single finding was judged from the diff alone.

---

## Experiment 12: Is the agentic gain vendor-specific?

Experiment 11 ran the agentic gate with gpt-5.5. This experiment re-runs the same loop and tools with two non-OpenAI verifiers, Gemini 3.1 Pro and Claude Opus 4.8, over the same 26 findings. It is the agentic parallel to Experiment 6, which checked the static gate across vendors. Only the verifier model changes.

| Verifier | Dropped (of 26) | Read real source on | Tool calls | Finding kept |
|---|---|---|---|---|
| gpt-5.5 (Experiment 11) | 25 | 26 | 190 | docs.py:188 |
| Claude Opus 4.8 | 25 | 26 | 91 | docs.py:188 |
| Gemini 3.1 Pro | 24 | 26 | 133 | docs.py:188 |

Every verifier, across three vendors, called the tools and read real source on all 26 findings. The agentic behavior is therefore not specific to the OpenAI model. Given tools, each frontier verifier investigated the real code rather than judging from the diff alone. All three independently kept the same single finding as real, the FastAPI Windows path-separator claim at docs.py:188 (confidence 0.84), which strengthens the read that it is a genuine borderline rather than a clear false positive. Opus matched gpt-5.5 exactly, dropping 25 and refuting from the staging script the FastAPI false positive the static gate had kept. Gemini dropped 24, one fewer, because it read the code on that disputed finding but did not return a verdict within the tool budget, so it failed open and kept the finding rather than refuting it.

The cross-vendor reading mirrors Experiment 6. The static gate held across vendors at 23 to 25 of 26, and the agentic gate holds too, at 24 to 25 of 26 dropped with the same survivor across all three. The agentic gate is a vendor-independent precision filter rather than a behavior of one model family. The full cross-vendor runs cost $3.25 for Opus and $2.50 for Gemini at OpenRouter prices.

---

## Experiment 13: Do the one-click fix suggestions fix the bug?

The bot attaches a one-click GitHub suggestion to a finding when the fix is an obvious single-line change. This experiment runs the deployed model over the 8 planted-bug fixtures, each a diff with one known bug and a known fix, and hand-scores each suggestion against the planted bug. The per-suggestion verdicts are in [`eval/suggestion-scores.md`](../eval/suggestion-scores.md).

| Measure | Result |
|---|---|
| Planted bugs the bot offered a fix for | 7 of 8 |
| Suggestions that correctly fix the bug | 6 of 7 |
| Correct abstentions, no single-line fix | 1 of 8 (path traversal) |

The deployed model produced a correct one-click fix for 6 of the 8 planted bugs: the parameterized query for SQL injection, execFile for command injection, the loop bound, the comparison operator, the environment-variable read for the hardcoded secret, and the secure random source. On the path-traversal bug it correctly offered no suggestion, because the fix is not a single line. The one wrong suggestion was on the swallowed-error bug, where the model offered a single-line change that does not stop the empty catch from swallowing, and the real fix spans more than one line, so it should have abstained as it did on path traversal. One of the six correct fixes uses require(), which is right in intent but would not compile in an ES module.

So the one-click fix is usually correct, and the model abstains when the fix does not fit a single line, but the feature has a real failure mode where it over-suggests on a bug whose fix is multi-line. The conservative reading is that a suggestion is an accelerator the reviewer still confirms, not an auto-apply. A separate real-GitHub check (`eval/suggestion-apply-check.ts`) confirmed all 9 suggestions are applyable, each accepted and anchored to its line on a scratch pull request that the check then cleans up.

---

## Experiment 14: Is the PR walkthrough accurate?

The opt-in walkthrough summarizes a change as a table at the top of the review. This experiment runs the walkthrough generator over a 7-PR sample of the frozen set, from a one-line null-check removal to a seven-file cleanup, and hand-scores each item for coverage and accuracy against the diff. The per-PR verdicts are in [`eval/walkthrough-scores.md`](../eval/walkthrough-scores.md).

| Measure | Result |
|---|---|
| PRs with every changed file described | 7 of 7 |
| Items describing a real change | 18 of 20 |
| Hallucinated items, a file not in the diff | 2 of 20 |

Coverage was complete. Every changed file is described on all seven PRs, and on the multi-file PRs the walkthrough groups related files into one item rather than padding the list. The descriptions are accurate where they describe a changed file. Spot checks confirm the removed Spring Boot null guard and the axios switch to the `own()` guard for inherited config.

The failure mode is hallucination. Two of the twenty items describe a file that is not in the diff at all, a changelog entry for axios 10929 and a CJS-typings update for axios 10922. Both are plausible changes the PRs did not make, and both are on axios, where most PRs do touch a changelog and the typings, so the model pattern-matched the repository's usual shape and invented the expected-but-absent change. This is the same overconfidence the precision experiments found, in a new place. The walkthrough is a reviewer aid that still needs the diff, not a substitute for it.

---

## Experiment 15: How noisy is the bot at scale?

Experiments 1 and 8 measured noise on 22 PRs from four repos, flagged as a method demonstration rather than a precise rate. This experiment scales that to 200 real merged PRs from 19 major repositories across 6 languages. Each PR runs through the deployed model's exact review path, and every diff-anchored finding is scored by a separate, balanced LLM judge (gpt-5.3-codex, a different model from the reviewer). The judge is validated against the 83 hand-scored findings first, matching the hand labels on 78% of the false positives and keeping 3 of the 4 real or borderline ones, so its rate is calibrated and, because it under-calls false positives, a lower bound. The method and per-language verdicts are in [`eval/largescale-scores.md`](../eval/largescale-scores.md).

| Measure | Result |
|---|---|
| PRs, repos, languages | 200, 19, 6 |
| Findings posted | 232 (1.16 per PR) |
| Judge-scored false positives | 208 of 232, 90% (95% CI 85 to 93%) |

The roughly 90% false-positive rate holds at scale. The 22-PR result was not an artifact of four repositories. Across 19 repos and six languages, about nine in ten of the deployed model's findings are false positives, and since the judge under-calls them, the true rate is at least that. The well-sampled languages, JavaScript, TypeScript, and Python, land between 79% and 97%. This is the project's central precision claim made into a measured rate rather than a demonstration. The run cost about $5 at OpenRouter prices and was held inside budget by a live balance floor.

---

## Conclusion

Recall was not the differentiator. All three models caught every planted, diff-evident bug. The difference was precision on accepted code. Mini posted 26 findings on merged PRs, nearly all of them false positives, including three confident criticals that should not have been posted. gpt-5.5 and gpt-5.3-codex posted 5–6 on the same PRs.

A refutation-first verification gate addresses this asymmetry. It removes findings the diff does not support and keeps findings the diff confirms. Run over mini's output, it removed 24 of the 26 findings while preserving every planted-bug catch, at the cost of two verifier calls per finding that reaches the gate. Cross-vendor verifiers reached the same verdicts on 23 to 25 of the 26 findings, so the effect does not depend on the verifier sharing the base model's vendor.

Adding full-file context did not substitute for the gate. The most confident false positive survived grounding in 4 of 4 runs and the critical-severity count did not fall, so context-grounding and verification are complementary rather than alternatives. Cross-file context did help recall on three of five planted cross-file bugs, but only where the model used the dependency's stated contract. The other two were missed even with the dependency in context. Across both axes the bottleneck is the model's use of context, not its availability, which is the calibration the gate targets directly.

---

## Limitations

- **Recall scope.** Recall was measured on planted, diff-evident bugs. A finding was counted as a catch if it was anchored to a valid diff line within the planted fixture's file. The pipeline did not verify that the finding described the planted bug or require any particular severity. Recall on subtle, cross-file, or semantic bugs is untested and would require a labeled dataset of known real regressions.
- **Sample size and selection.** The noise measurement covers 22 merged PRs drawn as the most recent qualifying PRs from four high-profile, heavily reviewed repositories, a selection that likely understates false positive rates on lower-quality or internal code. At 22 PRs this is a method demonstration, not a precise rate. Experiment 15 scales it to 200 PRs across 19 repositories and 6 languages and finds the same roughly 90% rate, judge-scored and validated against the hand labels.
- **Scoring scope.** Experiment 8 hand-scores every finding for precision. Those labels are the author's judgments against the code, not a model's, and several rest on source outside the frozen diff fetched from the merged projects. The boundary findings are flagged rather than rounded.
- **Same-vendor coverage.** Experiment 1's clean noise comparison covers same-vendor generators only. Experiment 6 addresses the verifier side by re-running the gate with cross-vendor verifiers (Gemini 3.1 Pro and Opus 4.8), which reached the same verdicts on 23 to 25 of 26 findings. Cross-vendor coverage of the base-model noise comparison itself remains future work, since Opus returned provider-routing 404s as a generator in the noise panel.
- **Labeling.** Labels are the author's judgments against the code, with no second coder.
- **Grounding comparison.** Experiment 4 used a single full run per condition, and grounding is non-deterministic, so the robustness check covers only the flagship PR (re-run four times). The new criticals that appeared under grounding were not individually labeled, so the no-reduction result is a count of critical-severity findings rather than a verified false-positive rate.
- **Cross-file recall.** Experiment 5 uses five planted fixtures, not real bugs, scored by the author against the known planted bug, on one model (gpt-5.4-mini) at three runs per condition. It demonstrates the direction (cross-file context helps recall when the contract is read) rather than a precise rate, and a real cross-file bug dataset would be needed to measure recall in the wild.
- **Agentic verification.** Experiment 11 ran a single tool-using verifier (gpt-5.5) on one stochastic run, and it is compared against the two-model static panel rather than a single static gpt-5.5, so the one-finding edge is directional rather than a precise gain. The reads the verifier made were not separately audited for correctness, and one pull request (axios #10901) no longer resolves on the GitHub API, so its finding was judged from the diff alone. Experiment 12 repeats the agentic gate across vendors, but each verifier is still one stochastic run, and all three kept the same finding the per-finding audit scored a false positive, which could be three independent confirmations that it is real or a shared blind spot.

---

## How to reproduce

```bash
# Freeze PRs: uses gh CLI auth (gh auth login), no OPENAI_API_KEY needed for this step
npx tsx eval/eval-replay.ts --select

# Run a model: requires OPENAI_API_KEY and OPENAI_BASE_URL in .env.local
npx tsx eval/eval-replay.ts --model openai/gpt-5.4-mini

# Run the verification layer over mini's results
npx tsx eval/eval-verify.ts

# Run the recall fixtures
npx tsx eval/eval-recall.ts

# Run recall preservation
npx tsx eval/eval-recall-verify.ts

# Grounding experiment: re-review the 22 PRs with full-file context
npx tsx eval/grounding-eval.ts

# Robustness check: re-run the flagship false positive under grounding four times
npx tsx eval/grounding-axios-repeat.ts

# Cross-file recall: diff-only vs grounded on five planted cross-file bugs
npx tsx eval/crossfile-recall-eval.ts

# Cross-vendor verification: re-run the gate with a non-OpenAI verifier
npx tsx eval/crossvendor-verify.ts                                        # Gemini (default)
CV_VERIFIERS=anthropic/claude-opus-4.8 npx tsx eval/crossvendor-verify.ts  # Opus

# Agentic verification: the shipping tool-using verifier over mini's 26 findings
npx tsx eval/verify-tools-eval.ts                  # needs gh auth to read repo files

# Cross-vendor agentic verification (Experiment 12): same loop, non-OpenAI verifiers
TOOLS_EVAL_MODEL=google/gemini-3.1-pro-preview npx tsx eval/verify-tools-eval.ts
TOOLS_EVAL_MODEL=anthropic/claude-opus-4.8 npx tsx eval/verify-tools-eval.ts

# Suggestion quality (Experiment 13): one-click fixes over the 8 planted bugs
npx tsx eval/suggestion-eval.ts

# Walkthrough quality (Experiment 14): hand-scored over a 7-PR sample
npx tsx eval/walkthrough-eval.ts

# Large-scale precision benchmark (Experiment 15): fetch reviewable PRs, then review + judge
PER_REPO=15 npx tsx eval/fetch-prs.ts                            # freeze the PR set (gh auth)
SKIP_VALIDATE=1 TARGET_PRS=200 npx tsx eval/largescale-eval.ts   # resumable, live-balance capped

# Multi-agent review: planner -> reviewer -> critic on a strong base, vs single-pass
npx tsx eval/multiagent-review.ts                  # precision arm over the 22 PRs
MA_MODE=recall npx tsx eval/multiagent-review.ts   # recall arm over the planted bugs

# Gate against the full hand-scored set: run the production verifier over all 83 findings
npx tsx eval/gate-full-audit.ts

# Confidence calibration: reliability table, ECE, and Brier from the hand labels (no model calls)
npx tsx eval/calibration.ts

# Render the reliability diagram (docs/reliability.svg) from the calibration result
npx tsx eval/reliability-diagram.ts
```

Per-finding precision verdicts (Experiment 8) are recorded in [`eval/finding-scores.md`](./finding-scores.md).

Results are written to `eval/eval-results-<model>.jsonl`, `eval/eval-verify-results.jsonl`, `eval/eval-recall-results.jsonl`, `eval/eval-results-grounded-mini.jsonl`, and `eval/eval-verify-crossvendor-<verifier>.jsonl`. Recall preservation, the grounding robustness check, and the cross-file recall experiment print to stdout.
