# Large-scale precision benchmark

This file records the method and result of Experiment 15, which scales the noise
measurement from 22 pull requests to 200 real merged pull requests across 19
major repositories and 6 languages. It backs Experiment 15 in
[`docs/evaluation.md`](../docs/evaluation.md). The frozen PR set is in
`eval/largescale-prs.json` and the per-PR results are in
`eval/eval-largescale.jsonl`.

## Method

- **Sample.** 200 merged PRs from 19 repositories (React, Vue, Angular, prettier,
  axios, TypeScript, Django, pandas, FastAPI, Flask, ruff, Deno, Spring Boot,
  gin, and others), filtered to reviewable PRs: merged, not a bot or a version
  bump, at least one code file, and a patch in the size range the bot reviews.
  See `eval/fetch-prs.ts`.
- **Review.** Each PR goes through the deployed model's exact review path
  (gpt-5.4-mini, the same system prompt and diff-anchor validation as
  production).
- **Judge.** Every diff-anchored finding is scored real or false positive by a
  separate, balanced LLM judge (gpt-5.3-codex), a different model from the
  reviewer so it is not grading its own output.
- **Judge validation.** Before the judge is trusted, it is run over the 83
  hand-scored findings from Experiment 8. It matched the hand labels on 78% of
  the false positives and kept 3 of the 4 real or borderline ones. Its rate is
  therefore calibrated against ground truth, and because it under-calls false
  positives (it misses about 22%), the rate it reports is a lower bound on the
  true rate.

## Result

200 PRs, 232 findings posted (1.16 per PR). Judge-scored false positives: 208 of
232, which is 90% with a 95% Wilson interval of 85% to 93%.

| Language | False positives / findings | Rate |
|---|---|---|
| JavaScript and TypeScript (mixed repos) | 75 / 80 | 94% |
| JavaScript | 50 / 54 | 93% |
| Python | 35 / 36 | 97% |
| TypeScript | 34 / 43 | 79% |
| Rust and TypeScript (Deno) | 8 / 9 | 89% |
| Go | 3 / 5 | 60% (small sample) |
| Java | 2 / 2 | 100% (small sample) |
| Python and Rust (ruff) | 1 / 3 | 33% (small sample) |

## Reading

The roughly 90% false-positive rate holds at scale. The original 22-PR result
was not an artifact of four repositories. Across 19 repos and six languages,
about nine in ten of the deployed model's findings are false positives, and
since the judge under-calls them, the true rate is at least that. The
well-sampled languages, JavaScript, TypeScript, and Python, all land between 79%
and 97%. The three small-sample languages, Go, Java, and the Rust-only ruff
slice, have too few findings to read into. This turns the project's central
precision claim from a 22-PR demonstration into a measured rate.

## Honesty notes

- This is judge-scored, not hand-scored. The judge is validated at 78% on the
  hand labels, so the 90% figure is a calibrated lower bound, not a hand audit.
- The result file records per-PR finding and false-positive counts for all 200
  PRs. The first 109 carry counts only; the rest also carry the per-finding
  verdicts. The rate is computed from the counts, which are uniform across all
  200.
- The run cost about $5 at OpenRouter prices and was held inside budget by a
  live balance floor, added after an earlier run showed that a token-based
  estimate under-counts a reasoning judge.
