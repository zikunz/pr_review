import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { KNOWN_MODELS } from '@/lib/cost';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Skip `.env.local` in production so a forgotten file shipped inside the
// deployment artifact cannot silently override Railway's environment.
// Railway sets `NODE_ENV=production`, so this is a no-op for that path.
if (process.env.NODE_ENV !== 'production') {
  loadDotenv(resolve(process.cwd(), '.env.local'));
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(100)
    .transform((s) => s.replace(/\\n/g, '\n')),
  GITHUB_WEBHOOK_SECRET: z.string().min(32),
  // `pr-cascade-bot` is the App slug the project owner registered, not a
  // generic fallback. Forks deploying this code should override the value
  // to match the App slug they registered for their own deployment.
  GITHUB_BOT_USERNAME: z.string().min(1).default('pr-cascade-bot'),
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  // Validated against the pricing table so an unknown model fails at startup
  // rather than at request time, where `estimateCost` would throw inside
  // `runReview` and the handler would silently drop the review with only a
  // `review.pricing_missing` trace event for the operator to find.
  OPENAI_MODEL: z
    .string()
    .min(1)
    .default('gpt-5.4-mini')
    .refine((model) => KNOWN_MODELS.includes(model), {
      message: `OPENAI_MODEL must be one of: ${KNOWN_MODELS.join(', ')}. Add the model to PRICING in src/lib/cost.ts before pointing the bot at it.`,
    }),
  COST_CAP_CENTS_PER_REVIEW: z.coerce.number().positive().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      code: i.code,
      message: i.message,
    }));
    console.error('Invalid environment configuration');
    console.error(JSON.stringify(fieldErrors, null, 2));
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
