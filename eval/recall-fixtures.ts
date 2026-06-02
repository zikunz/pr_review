/**
 * Planted-bug recall fixtures, shared by the recall experiments.
 *
 * Each fixture is a small new-file diff containing exactly one planted,
 * diff-evident bug. Used by eval/eval-recall.ts (single-model recall) and
 * eval/multiagent-review.ts (does the multi-agent critic preserve real bugs).
 *
 * NOTE: the `hardcoded-secret` fixture contains a deliberately FAKE Stripe key
 * (`sk_live_...Real0LookingSecretValue`) as test data. It is not a real
 * credential. The file is allowlisted in .gitleaks.toml.
 */
export interface RecallFixture {
  id: string;
  title: string;
  file: string;
  bug: string;
  patch: string;
}

export const RECALL_FIXTURES: RecallFixture[] = [
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
