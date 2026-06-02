export interface ModelPricing {
  inputPerMillionTokensUsd: number;
  outputPerMillionTokensUsd: number;
  cachedInputPerMillionTokensUsd?: number;
}

// Pricing snapshot taken from platform.openai.com/docs/pricing on
// 2026-05-20 and updated 2026-06-01. Costs are USD per million tokens.
// Re-check the snapshot before promoting a new tier or before publishing
// cost numbers in any external writeup, since OpenAI updates prices
// periodically. gpt-5.3-codex pricing verified against the OpenRouter
// public models API (openrouter.ai/api/v1/models) on 2026-06-01.
const PRICING: Record<string, ModelPricing> = {
  'gpt-5.4-mini': {
    inputPerMillionTokensUsd: 0.75,
    outputPerMillionTokensUsd: 4.5,
    cachedInputPerMillionTokensUsd: 0.075,
  },
  'gpt-5.4': {
    inputPerMillionTokensUsd: 2.5,
    outputPerMillionTokensUsd: 15,
    cachedInputPerMillionTokensUsd: 0.25,
  },
  'gpt-5.5': {
    inputPerMillionTokensUsd: 5,
    outputPerMillionTokensUsd: 30,
    cachedInputPerMillionTokensUsd: 0.5,
  },
  'gpt-5.3-codex': {
    inputPerMillionTokensUsd: 1.75,
    outputPerMillionTokensUsd: 14,
    cachedInputPerMillionTokensUsd: 0.175,
  },
};

// Exposed so the env loader can reject `OPENAI_MODEL` values that have no
// pricing entry at startup, instead of letting the unknown name silently
// drop reviews at request time through `estimateCost`'s throw path.
export const KNOWN_MODELS = Object.freeze(Object.keys(PRICING)) as readonly string[];

// OpenRouter and other OpenAI-compatible gateways prefix the model name with
// a provider slug, for example `openai/gpt-5.4-mini`. The pricing table keys
// on the bare model name, so strip any leading `provider/` segment before a
// lookup. A bare name (no slash) passes through unchanged.
export function normalizeModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

export interface CostBreakdown {
  inputCents: number;
  outputCents: number;
  cachedInputCents: number;
  totalCents: number;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): CostBreakdown {
  const pricing = PRICING[normalizeModel(model)];
  if (!pricing) {
    throw new Error(`No pricing registered for model: ${model}`);
  }
  // OpenAI returns prompt_tokens as the full prompt count (cached + fresh).
  // Subtract cached to bill the fresh portion at the standard rate and the
  // cached portion at the cheaper rate.
  const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = pricing.cachedInputPerMillionTokensUsd ?? pricing.inputPerMillionTokensUsd;

  const inputCents = (freshInputTokens * pricing.inputPerMillionTokensUsd) / 10_000;
  const outputCents = (outputTokens * pricing.outputPerMillionTokensUsd) / 10_000;
  const cachedInputCents = (cachedInputTokens * cachedRate) / 10_000;

  return {
    inputCents,
    outputCents,
    cachedInputCents,
    totalCents: inputCents + outputCents + cachedInputCents,
  };
}

export class CostCapExceededError extends Error {
  constructor(
    public readonly actualCents: number,
    public readonly capCents: number,
  ) {
    super(`Review cost ${actualCents.toFixed(4)}c exceeds cap ${capCents}c`);
    this.name = 'CostCapExceededError';
  }
}

export function enforceCostCap(actualCents: number, capCents: number): void {
  if (actualCents > capCents) {
    throw new CostCapExceededError(actualCents, capCents);
  }
}
