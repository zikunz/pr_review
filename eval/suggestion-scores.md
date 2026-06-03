# Suggestion quality audit

This file records a hand review of the one-click fix suggestions the deployed
model (gpt-5.4-mini) produced on the 8 planted-bug fixtures
(`eval/recall-fixtures.ts`), backing Experiment 13 in
[`docs/evaluation.md`](../docs/evaluation.md). Each fixture is a small diff with
one known, diff-evident bug and a known correct fix. A suggestion is CORRECT
when applying it verbatim fixes the planted bug with valid code. The raw
suggestions are in `eval/eval-suggestions.jsonl`.

## Result

| Fixture | Planted bug | Suggestion | Correct |
|---|---|---|---|
| sql-injection | SQL injection | parameterized query with a placeholder and an `orderId` argument | yes |
| command-injection | command injection | `execFile('convert', [path, ...])`, which passes arguments without a shell | yes |
| path-traversal | path traversal | none offered | yes, a correct abstention, because the fix is not a single line |
| off-by-one | reads `items[length]` | changes the loop bound from `<=` to `<` | yes |
| assignment-in-condition | `=` instead of `==` | changes the assignment to `===` | yes |
| hardcoded-secret | live key in source | reads the key from `process.env.STRIPE_SECRET` | yes |
| weak-random-token | `Math.random()` token | `crypto.randomBytes(32).toString('hex')` | yes in intent, but it calls `require('crypto')`, which does not compile in an ES module |
| empty-catch-swallow | swallowed charge error | adds `await` to the charge call | no, the empty catch still swallows the error, and the real fix spans more than one line |

## Reading

Of the 8 planted bugs, the bot offered a one-click fix on 7 and correctly
offered none on 1, the path-traversal bug, whose fix is not a single line. Of
the 7 suggestions, 6 fix the bug and 1, the swallowed-error bug, does not. That
last one is an over-eager suggestion: the model proposed a single-line change on
a bug whose fix spans more than the one line a suggestion can replace, where it
should have abstained as it did on path traversal. One of the 6 correct fixes,
the weak-random-token one, uses `require()`, which is correct in intent but would
not compile in an ES module.

The headline is that the one-click fix is usually right. Six of the eight bugs
get a correct fix and seven of eight get an actionable one, and the model
abstains when the fix does not fit a single line. The feature is not perfect.
It over-suggested on the swallowed-error bug, so the conservative reading is that
a suggestion is an accelerator the reviewer still confirms, not an auto-apply.
