/**
 * Cross-file recall experiment (v0.4 candidate). Completes the grounding story.
 *
 * Experiment 4 showed grounding does NOT fix same-file confident false
 * positives. This tests the other axis: does cross-file context (the dependency
 * a finding needs, which a diff-only review cannot see) improve RECALL on bugs
 * whose root cause lives in another file?
 *
 * Five planted fixtures. Each has fileA (the changed file / diff) and fileB
 * (an unchanged dependency). The bug is on a changed line in fileA but is only
 * detectable by reading fileB. Two conditions, each run K times:
 *   - diff-only : fileA diff alone (the bot's default, expected to MISS)
 *   - grounded  : fileA diff + fileB full content (expected to CATCH)
 *
 * "Caught" = the model posts a finding anchored to fileA's changed line. Each
 * caught finding's message is printed so it can be checked by hand against the
 * planted bug (the same honest criterion as the recall test in Experiment 2).
 *
 * Run: npx tsx eval/crossfile-recall-eval.ts
 */
import { zodResponseFormat } from 'openai/helpers/zod';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { client } from '@/openai/review';
import { ReviewOutput } from '@/openai/schema';

process.env.GITHUB_APP_ID ||= 'crossfile-unused';
process.env.GITHUB_APP_PRIVATE_KEY ||= `crossfile-unused-${'x'.repeat(120)}`;
process.env.GITHUB_WEBHOOK_SECRET ||= `crossfile-unused-${'x'.repeat(40)}`;

const MODEL = process.env.CROSSFILE_MODEL ?? 'openai/gpt-5.4-mini';
const RUNS = 3;
const MAX_COMPLETION_TOKENS = 4000;

interface Fixture {
  id: string;
  title: string; // neutral PR title, must NOT hint at the bug
  bug: string; // the planted cross-file bug, for hand-checking
  fileA: { filename: string; patch: string };
  fileB: { filename: string; content: string };
}

const FIXTURES: Fixture[] = [
  {
    id: 'wrong-arg-count',
    title: 'Charge the customer on checkout',
    bug: 'charge() is defined as charge(userId, amountCents) in fileB, but fileA calls charge(order.totalCents) — the amount is passed as the userId and amountCents is undefined.',
    fileA: {
      filename: 'src/checkout.ts',
      patch: [
        '@@ -10,5 +10,6 @@ export async function checkout(orderId) {',
        '   const order = await loadOrder(orderId);',
        "   if (!order) throw new Error('no order');",
        '+  charge(order.totalCents);',
        '   return { ok: true };',
        ' }',
      ].join('\n'),
    },
    fileB: {
      filename: 'src/payments/gateway.ts',
      content: [
        '// Charges the customer. `userId` identifies the customer; `amountCents`',
        '// is the amount to charge in cents.',
        'export function charge(userId, amountCents) {',
        '  return gateway.run({ customer: userId, amount: amountCents });',
        '}',
      ].join('\n'),
    },
  },
  {
    id: 'inverted-return-contract',
    title: 'Create the user after validating the email',
    bug: 'validateEmail() returns null when valid and an error string when invalid, so `if (validateEmail(email))` creates the user only when the email is INVALID (inverted logic).',
    fileA: {
      filename: 'src/signup.ts',
      patch: [
        '@@ -5,3 +5,6 @@ export function signup(email) {',
        '   email = email.trim();',
        '+  if (validateEmail(email)) {',
        '+    return createUser(email);',
        '+  }',
        '   return null;',
        ' }',
      ].join('\n'),
    },
    fileB: {
      filename: 'src/validate.ts',
      content: [
        '// Returns null when the email is valid, or an error string when invalid.',
        'export function validateEmail(email) {',
        "  return email.includes('@') ? null : 'invalid email';",
        '}',
      ].join('\n'),
    },
  },
  {
    id: 'missing-export',
    title: 'Parse the start date in the report',
    bug: 'fileA imports { parseDate } from ./dateutil, but dateutil only exports formatDate — parseDate is undefined and the call crashes at runtime.',
    fileA: {
      filename: 'src/report.ts',
      patch: [
        '@@ -1,4 +1,6 @@',
        " import { loadRows } from './db';",
        "+import { parseDate } from './dateutil';",
        ' export function report(input) {',
        '+  const start = parseDate(input.start);',
        '   return loadRows({ ...input, start });',
        ' }',
      ].join('\n'),
    },
    fileB: {
      filename: 'src/dateutil.ts',
      content: [
        'export function formatDate(d) {',
        '  return d.toISOString().slice(0, 10);',
        '}',
        '// This module intentionally exports only formatDate.',
      ].join('\n'),
    },
  },
  {
    id: 'unit-mismatch',
    title: 'Cache the session with a TTL',
    bug: 'setWithTtl expects ttl in SECONDS (per fileB), but fileA passes 30 * 60 * 1000 milliseconds, giving a ~20-day TTL instead of 30 minutes.',
    fileA: {
      filename: 'src/session.ts',
      patch: [
        '@@ -8,3 +8,4 @@ export function startSession(data) {',
        '   const id = newId();',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source under review, not a JS template literal
        '+  setWithTtl(`session:${id}`, data, 30 * 60 * 1000);',
        '   return id;',
        ' }',
      ].join('\n'),
    },
    fileB: {
      filename: 'src/cache.ts',
      content: [
        '// `ttlSeconds` is the time-to-live in SECONDS.',
        'export function setWithTtl(key, value, ttlSeconds) {',
        '  store.set(key, value, { expireIn: ttlSeconds });',
        '}',
      ].join('\n'),
    },
  },
  {
    id: 'null-contract',
    title: 'Return the profile name',
    bug: 'findUser() can return null (per fileB), but fileA dereferences findUser(id).name without a null check, throwing when the user does not exist.',
    fileA: {
      filename: 'src/profile.ts',
      patch: [
        '@@ -3,3 +3,4 @@ export function profile(req) {',
        '   const id = req.userId;',
        '+  const name = findUser(id).name;',
        '   return { name };',
        ' }',
      ].join('\n'),
    },
    fileB: {
      filename: 'src/repo.ts',
      content: [
        '// Returns the user record, or null if no user exists with that id.',
        'export function findUser(id) {',
        '  return db.get(id) ?? null;',
        '}',
      ].join('\n'),
    },
  },
];

function diffOnlyPrompt(fx: Fixture): string {
  return buildUserPrompt({ prTitle: fx.title, prBody: null, files: [fx.fileA] });
}

function groundedPrompt(fx: Fixture): string {
  const base = buildUserPrompt({ prTitle: fx.title, prBody: null, files: [fx.fileA] });
  const longestRun = (fx.fileB.content.match(/`+/g) ?? ['']).reduce(
    (m, s) => Math.max(m, s.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [
    base,
    '',
    '# Related file context',
    'The complete content of a file the diff depends on is below, so you can judge the change against the code it calls into. Only comment on lines that appear in the diff above.',
    '',
    `### ${fx.fileB.filename} (full file)`,
    fence,
    fx.fileB.content,
    fence,
  ].join('\n');
}

async function runOnce(
  prompt: string,
  fx: Fixture,
): Promise<{ caught: boolean; message?: string }> {
  const locations = parseDiffLocations([{ path: fx.fileA.filename, patch: fx.fileA.patch }]);
  const completion = await client().chat.completions.parse({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  });
  const findings = completion.choices[0]?.message?.parsed?.findings ?? [];
  const onFileA = findings.filter((f) => isValidCommentLocation(locations, f.file, f.line));
  return { caught: onFileA.length > 0, message: onFileA[0]?.message };
}

async function main(): Promise<void> {
  console.log(
    `Cross-file recall: model=${MODEL}, ${FIXTURES.length} fixtures, ${RUNS} runs/condition\n`,
  );
  let diffOnlyTotal = 0;
  let groundedTotal = 0;
  const denom = FIXTURES.length * RUNS;

  for (const fx of FIXTURES) {
    let dCaught = 0;
    let gCaught = 0;
    const dMsgs: string[] = [];
    const gMsgs: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const d = await runOnce(diffOnlyPrompt(fx), fx);
      if (d.caught) {
        dCaught++;
        if (d.message) dMsgs.push(d.message);
      }
      const g = await runOnce(groundedPrompt(fx), fx);
      if (g.caught) {
        gCaught++;
        if (g.message) gMsgs.push(g.message);
      }
    }
    diffOnlyTotal += dCaught;
    groundedTotal += gCaught;
    console.log(`### ${fx.id}`);
    console.log(`  planted bug: ${fx.bug}`);
    console.log(`  diff-only caught: ${dCaught}/${RUNS}`);
    // Print every caught message so the catch can be hand-checked against the
    // planted bug (anchored != necessarily about the bug).
    for (const m of dMsgs) console.log(`    [diff-only] "${m.slice(0, 150)}"`);
    console.log(`  grounded  caught: ${gCaught}/${RUNS}`);
    for (const m of gMsgs) console.log(`    [grounded]  "${m.slice(0, 150)}"`);
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`diff-only recall: ${diffOnlyTotal}/${denom}`);
  console.log(`grounded  recall: ${groundedTotal}/${denom}`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
