# Walkthrough quality audit

This file records a hand review of the PR walkthroughs the deployed model
(gpt-5.4-mini) produced on a 7-PR sample of the frozen set, backing Experiment
14 in [`docs/evaluation.md`](../docs/evaluation.md). The sample spans a one-line
null-check removal to a seven-file cleanup, across axios, Spring Boot, and
FastAPI. Each item is judged for coverage (is every changed file described?) and
accuracy (does the item describe a real change in a changed file, with no
hallucination?). The raw walkthroughs are in `eval/eval-walkthrough.jsonl`.

## Result

| PR | Files | Items | Coverage | Hallucinated items |
|---|---|---|---|---|
| spring-boot 50504, remove null check | 1 | 1 | full | 0 |
| axios 10956, toJSON types | 1 | 1 | full | 0 |
| axios 10929, auth on redirects | 2 | 3 | full | 1 (`PRE_RELEASE_CHANGELOG.md`) |
| fastapi 15589, underscore headers | 2 | 2 | full | 0 |
| axios 10920, zstd support | 6 | 5 | full | 0 |
| axios 10922, error-handling cleanup | 7 | 5 | full | 1 (`index.d.cts`) |
| fastapi 15580, docs references | 3 | 3 | full | 0 |
| **total** | | **20** | **7 of 7 full** | **2** |

## Reading

Coverage was complete. Every changed file is described on all seven PRs, and on
the multi-file PRs the walkthrough groups related files into one item rather
than padding the list. The descriptions are accurate where they describe a
changed file. Two spot checks confirm this. The Spring Boot item correctly
reports the removed `getLettuce()` null guard, and the axios `resolveConfig`
item correctly reports the switch to the `own()` guard for `params` and
`paramsSerializer`.

The failure mode is hallucination. Two of the twenty items describe a file that
is not in the diff at all, a `PRE_RELEASE_CHANGELOG.md` entry for axios 10929 and
an `index.d.cts` typings update for axios 10922. Both are plausible changes the
PRs did not make, and both are on axios, where most PRs do touch a changelog and
the CJS typings. The model pattern-matched the repository's usual shape and
invented the expected-but-absent change.

So the walkthrough reliably covers and accurately describes the real changes,
but it occasionally adds a confident, plausible item for a change that did not
happen. It is a reviewer aid that still needs the diff, not a substitute for it.
