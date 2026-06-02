import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CASCADE_DEFAULTS } from '@/lib/cascade';
import { KNOWN_MODELS, normalizeModel } from '@/lib/cost';

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
  // The OpenAI SDK is also used to talk to OpenAI-compatible gateways. Leave
  // OPENAI_BASE_URL unset to call OpenAI directly. Set it to
  // https://openrouter.ai/api/v1 to route every inference call through
  // OpenRouter (one key for all providers). The `sk-` prefix check below
  // already accepts OpenRouter keys, which are `sk-or-...`.
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  // Validated against the pricing table so an unknown model fails at startup
  // rather than at request time, where `estimateCost` would throw inside
  // `runReview` and the handler would silently drop the review with only a
  // `review.pricing_missing` trace event for the operator to find.
  // `normalizeModel` strips an OpenRouter-style `provider/` prefix so
  // `openai/gpt-5.4-mini` validates against the bare pricing-table keys.
  OPENAI_MODEL: z
    .string()
    .min(1)
    .default('gpt-5.4-mini')
    .refine((model) => KNOWN_MODELS.includes(normalizeModel(model)), {
      message: `OPENAI_MODEL must resolve (after stripping any provider/ prefix) to one of: ${KNOWN_MODELS.join(', ')}. Add the model to PRICING in src/lib/cost.ts before pointing the bot at it.`,
    }),
  COST_CAP_CENTS_PER_REVIEW: z.coerce.number().positive().default(30),
  // v0.3 verification gate. Off by default so deploying this code does not
  // change review behavior until an operator opts in with VERIFY_ENABLED=true.
  // When on, every finding that passes the diff-anchor gate is audited by each
  // model in VERIFY_MODELS, and a finding is dropped only when the panel
  // unanimously refutes it (see src/openai/verify.ts). VERIFY_MODELS is a
  // comma-separated list of slugs in the same form as OPENAI_MODEL: bare names
  // for the OpenAI API, or provider-prefixed (openai/gpt-5.5) for OpenRouter.
  VERIFY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  VERIFY_MODELS: z
    .string()
    .default('gpt-5.5')
    .transform((s) =>
      s
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    )
    .refine((models) => models.every((m) => KNOWN_MODELS.includes(normalizeModel(m))), {
      message: `VERIFY_MODELS must each resolve (after stripping any provider/ prefix) to one of: ${KNOWN_MODELS.join(', ')}`,
    }),
  // v0.2 cascade routing. Off by default (CASCADE_ENABLED=false) so the bot
  // continues to use OPENAI_MODEL for every review until an operator opts in.
  // When enabled, the tier is chosen from the diff signals (see
  // src/lib/cascade.ts) and the per-tier model slug is used instead of
  // OPENAI_MODEL. All three tier models must be in the PRICING table.
  CASCADE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Model slugs for each cascade tier. Use bare names for the OpenAI API or
  // provider-prefixed slugs (openai/gpt-5.4) when routing through OpenRouter.
  CASCADE_TIER1_MODEL: z
    .string()
    .default(CASCADE_DEFAULTS.tier1Model)
    .refine((m) => KNOWN_MODELS.includes(normalizeModel(m)), {
      message: `CASCADE_TIER1_MODEL must resolve (after stripping any provider/ prefix) to one of: ${KNOWN_MODELS.join(', ')}`,
    }),
  CASCADE_TIER2_MODEL: z
    .string()
    .default(CASCADE_DEFAULTS.tier2Model)
    .refine((m) => KNOWN_MODELS.includes(normalizeModel(m)), {
      message: `CASCADE_TIER2_MODEL must resolve (after stripping any provider/ prefix) to one of: ${KNOWN_MODELS.join(', ')}`,
    }),
  CASCADE_TIER3_MODEL: z
    .string()
    .default(CASCADE_DEFAULTS.tier3Model)
    .refine((m) => KNOWN_MODELS.includes(normalizeModel(m)), {
      message: `CASCADE_TIER3_MODEL must resolve (after stripping any provider/ prefix) to one of: ${KNOWN_MODELS.join(', ')}`,
    }),
  // Patch character count threshold that divides Tier 2 from Tier 3. PRs
  // whose total code-file patch is above this value are routed to the
  // frontier model. Default matches CASCADE_DEFAULTS.tier2MaxChars.
  CASCADE_TIER2_MAX_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(CASCADE_DEFAULTS.tier2MaxChars),
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
