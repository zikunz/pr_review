/**
 * Recall experiment. Feeds the bot's real review logic (same SYSTEM_PROMPT +
 * buildUserPrompt + ReviewOutput schema + diff-anchor gate) a set of small diffs,
 * each with ONE planted, diff-self-evident bug a senior reviewer must catch.
 * Measures recall per model (mini / gpt-5.5 / codex): does it flag the planted bug?
 *
 * Run: npx tsx eval/eval-recall.ts   (needs .env.local OPENAI_API_KEY/BASE_URL)
 * Output: eval/eval-recall-results.jsonl  (then judged by hand against the known bug)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { isValidCommentLocation, parseDiffLocations } from '@/github/diff';
import { buildUserPrompt, SYSTEM_PROMPT } from '@/openai/prompt';
import { ReviewOutput } from '@/openai/schema';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!(k in process.env)) process.env[k] = v;
}

const MODELS = ['openai/gpt-5.4-mini', 'openai/gpt-5.5', 'openai/gpt-5.3-codex'];

const FIXTURES: Array<{ id: string; title: string; file: string; bug: string; patch: string }> = [
  {
    id: 'sql-injection',
    title: 'Add order lookup endpoint',
    file: 'src/orders.ts',
    bug: 'SQL injection: req.query.orderId interpolated straight into the query',
    patch: `@@ -0,0 +1,4 @@
+export async function findOrder(req, db) {
+  const orderId = req.query.orderId;
+  return db.query(\`SELECT * FROM orders WHERE id = \${orderId}\`);
+}`,
  },
  {
    id: 'command-injection',
    title: 'Add image conversion helper',
    file: 'src/convert.ts',
    bug: 'Command injection: req.query.path passed unescaped into exec',
    patch: `@@ -0,0 +1,5 @@
+import { exec } from 'node:child_process';
+
+export function convertImage(req) {
+  exec('convert ' + req.query.path + ' /tmp/out.png');
+}`,
  },
  {
    id: 'path-traversal',
    title: 'Serve uploaded avatar',
    file: 'src/avatar.ts',
    bug: 'Path traversal: req.query.file (e.g. ../../etc/passwd) read with no sanitization',
    patch: `@@ -0,0 +1,5 @@
+import { readFileSync } from 'node:fs';
+
+export function getAvatar(req) {
+  return readFileSync('./uploads/' + req.query.file);
+}`,
  },
  {
    id: 'off-by-one',
    title: 'Sum cart totals',
    file: 'src/cart.ts',
    bug: 'Off-by-one: loop uses <= length, reads items[length] (out of bounds / undefined)',
    patch: `@@ -0,0 +1,6 @@
+export function total(items) {
+  let sum = 0;
+  for (let i = 0; i <= items.length; i++) {
+    sum += items[i].price;
+  }
+  return sum;
+}`,
  },
  {
    id: 'assignment-in-condition',
    title: 'Gate admin panel',
    file: 'src/auth.ts',
    bug: "Assignment in condition: if (user.role = 'admin') assigns, always truthy -> auth bypass",
    patch: `@@ -0,0 +1,5 @@
+export function canAccessAdmin(user) {
+  if (user.role = 'admin') {
+    return true;
+  }
+  return false;
+}`,
  },
  {
    id: 'hardcoded-secret',
    title: 'Wire up Stripe client',
    file: 'src/billing.ts',
    bug: 'Hardcoded live secret key committed in source',
    patch: `@@ -0,0 +1,4 @@
+import Stripe from 'stripe';
+
+const STRIPE_SECRET = 'sk_live_51HxQ2eK8mNpReal0LookingSecretValue';
+export const stripe = new Stripe(STRIPE_SECRET);`,
  },
  {
    id: 'weak-random-token',
    title: 'Generate password reset token',
    file: 'src/reset.ts',
    bug: 'Insecure randomness: Math.random() used to mint a security-sensitive reset token',
    patch: `@@ -0,0 +1,4 @@
+export function makeResetToken() {
+  // token emailed to the user to reset their password
+  return Math.random().toString(36).slice(2);
+}`,
  },
  {
    id: 'empty-catch-swallow',
    title: 'Charge customer on checkout',
    file: 'src/checkout.ts',
    bug: 'Empty catch swallows the payment error; checkout reports success even when the charge failed',
    patch: `@@ -0,0 +1,9 @@
+export async function checkout(cart, gateway) {
+  let ok = true;
+  try {
+    await gateway.charge(cart.total, cart.card);
+  } catch (e) {
+  }
+  return { success: ok };
+}`,
  },
];

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  timeout: 60_000,
  ...(process.env.OPENAI_BASE_URL?.includes('openrouter.ai')
    ? { defaultHeaders: { 'HTTP-Referer': 'https://github.com/zikunz/pr_review', 'X-Title': 'PR Cascade' } }
    : {}),
});

async function review(model: string, fx: (typeof FIXTURES)[number]) {
  const files = [{ filename: fx.file, patch: fx.patch }];
  const locations = parseDiffLocations([{ path: fx.file, patch: fx.patch }]);
  try {
    const c = await client.chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt({ prTitle: fx.title, prBody: null, files }) },
      ],
      response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
      max_completion_tokens: 16000,
    });
    const r = c.choices[0]?.message?.parsed;
    if (!r) return { error: 'no parsed review' };
    const posted = (r.findings || []).filter((f) => isValidCommentLocation(locations, f.file, f.line));
    return { posted };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message?.slice(0, 110)}` };
  }
}

async function main() {
  const results = [];
  for (const fx of FIXTURES) {
    console.log(`\n### ${fx.id} — planted bug: ${fx.bug}`);
    const byModel: Record<string, unknown> = {};
    for (const m of MODELS) {
      const r = await review(m, fx);
      byModel[m] = r;
      if ('error' in r) {
        console.log(`  ${m.split('/')[1]}: ERROR ${r.error}`);
      } else {
        console.log(`  ${m.split('/')[1]}: ${r.posted.length} finding(s)`);
        for (const f of r.posted) console.log(`     [${f.severity}|${f.category}] ${f.message.slice(0, 110)}`);
      }
    }
    results.push({ ...fx, byModel });
  }
  writeFileSync(
    resolve(process.cwd(), 'eval/eval-recall-results.jsonl'),
    `${results.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
  console.log(`\n-> eval/eval-recall-results.jsonl  (judge caught/missed by hand against each planted bug)`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
