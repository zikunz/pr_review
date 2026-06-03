# Per-finding precision audit

This file records a hand review of every finding the six review configurations
posted on the 22 merged PRs, judged against the actual code. It backs the
precision result in `docs/evaluation.md` (Experiment 8).

## Method

A finding is a TRUE POSITIVE only if it is a real, correct, worth-posting issue
as written, judged against the actual code. It is a FALSE POSITIVE if it
misreads a helper or API, the concern is already handled in the diff, it is
overstated (real pattern, wrong consequence), low-value, subjective, or the code
refutes it. The judgment is refutation-first, so it defaults to false positive unless
the code clearly confirms the issue. This is the same author-judgment rubric
used in Experiments 1 to 3, applied to every finding rather than a sample.

Many findings depend on code outside the frozen diff (a helper defined
elsewhere, a build file, a pinned library version). Those were resolved against
the real merged source fetched from each project, the same way Experiment 4
treated the axios `own` helper. Verdicts that rest on out-of-diff source are
marked as such below. The labels are the author's judgments, not a model's, and
the borderline cases are flagged honestly rather than rounded to a clean
number.

## Scope

83 findings across 20 PRs: cross-model noise panel 46 (mini 26, gpt-5.5
6, gpt-5.3-codex 5, gemini-3.1-pro 9, claude-opus-4.8 0), grounding re-review 28,
and the multi-agent pipeline 9. The verification and cross-vendor result files
re-judge mini's 26 and are not re-counted here.

## Result by configuration

| Configuration | Findings | Clear true positive | Borderline | False positive |
|---|---|---|---|---|
| gpt-5.4-mini (deployed) | 26 | 1 | 0 | 25 |
| gpt-5.5 | 6 | 0 | 1 | 5 |
| gpt-5.3-codex | 5 | 0 | 0 | 5 |
| gemini-3.1-pro-preview | 9 | 1 | 0 | 8 |
| claude-opus-4.8 | 0 | 0 | 0 | 0 |
| grounded-mini | 28 | 0 | 0 | 28 |
| multi-agent gpt-5.5 | 9 | 1 | 0 | 8 |
| **total detections** | **83** | **3** | **1** | **79** |

The single clear true positive is one underlying bug, surfaced independently by
three configurations (mini, gemini, multi-agent). The 83 rows are detections,
not distinct issues: 3 true-positive detections of that one bug, 1 borderline
detection (axios 10929), and 79 false-positive detections.

## The one clear true positive

**React PR 36566, `decodeReplyFromBusboy` control flow.** When the busboy
`finish` handler runs `flush()` and a queued `resolveField`/`resolveFileComplete`
throws, `flush()` does `busboyStream.destroy(error); return;` without setting
`closed`. The handler then reports `new Error('Reply finished with incomplete
file part.')`, which reaches the pending chunks synchronously and masks the real
decode error (delivered asynchronously via the stream `error` event). Verified
by the author directly from the frozen diff (the `catch` returns without
`closed`, the `finish` handler reports on `!closed`). Surfaced by gpt-5.4-mini
(confidence 0.73, mechanism imprecise), gemini-3.1-pro (high), and the
multi-agent pipeline (0.9).

## The two boundary findings

Two findings sit on the line between real and false. The first is counted as the
one borderline in the table above. The second is a borderline false positive and
is counted among the false positives, because its harm is not realized in the
repository.

- **axios PR 10929, redirect credential restoration (gpt-5.5, 0.76).** The
  same-origin check compares the redirect target to the fixed original origin
  rather than the immediately preceding hop, so an `original -> evil ->
  original/sensitive` chain restores the original Basic credentials on the final
  request. The mechanism is real (verified from the diff: `requestOrigin =
  parsed.origin` captured once). It is a genuine confused-deputy hardening gap,
  but the credentials reach the legitimate origin rather than the attacker, so
  severity is modest and a maintainer could reasonably defer it. Scored as a
  borderline true positive.
- **FastAPI PR 15563, translated non-Markdown assets (multi-agent and mini).**
  The staging overlay loops `rglob("*.md")` only, so a translated non-Markdown
  asset would not be staged. The mechanism is real (verified from the diff), but
  no non-Markdown translation assets exist in the repository today, so the
  claimed broken links do not occur. Scored as a borderline false positive
  (a latent-gap observation whose harm is not realized).

## Confidence calibration

Every finding at confidence 0.95 or above was a false positive: mini's 0.98
(axios `own` helper misread), 0.96 (Spring redundant null check), and 0.98
(React dropped exports), gemini's 1.00 (Spring jarmode write-to-root, refuted by
the merged passing test) and 0.95 (Spring `RabbitProperties.Stream.Ssl`, a class
that does not exist, verified by the author against the merged source). The
clear true positive carried confidences of 0.73 to 0.90. High model confidence
did not track correctness on this set. Experiment 10 quantifies this over all 83
findings: mean self-reported confidence 0.80 against an actual accuracy of 0.036,
an Expected Calibration Error of 0.76, and a Brier score of 0.63, where 0 is
perfect (`eval/calibration.ts`, result in `eval/eval-calibration.json`).

## Notes for re-verification

The author read the frozen diff for every one of the 20 PRs with findings and confirmed each of
the 83 verdicts directly against it, fetching the merged source where a
refutation depended on code outside the diff (the axios `own` helper,
`https-proxy-agent` v5, `follow-redirects` 1.16, the Spring `RabbitProperties` and
jarmode sources, and the mkdocs loader). The load-bearing judgments were verified
first. These are the one clear true positive (React 36566, confirmed from the
full flush control flow), both borderline mechanisms (axios 10929, FastAPI
15563), and every finding at confidence 0.95 or above, all of which are false,
including gemini's 1.00 jarmode claim that the merged, passing test refutes. The
headline conclusion (about one real issue, roughly 80 false positives, confidence
not tracking correctness) is robust to the exact treatment of the boundary findings.

## Adversarial cross-check (Experiment 9)

Experiment 9 ran the verification gate (gpt-5.5) over all 83 findings. The gate
kept 12 findings that this audit labels false positive. Each of those 12 was
re-examined to test whether the gate had caught a real bug this audit missed.
None had. The 12 are the same false positives already identified here, including
the two yaml-loader findings, the cached-agent TLS finding, the dropped-exports
finding, the validation-alias finding, and the FastAPI non-Markdown-asset finding (a
borderline false positive, surfaced twice). The highest-confidence of them, gemini's 1.00 claim that the Spring
jarmode command writes to the filesystem root, was re-verified directly against
the merged, passing test, which asserts the extracted file lands under the
temporary directory rather than the root. So the gate's 12 kept findings are
gate false-keeps, not real bugs, and the one-clear-true-positive ground truth
holds under this adversarial check.
