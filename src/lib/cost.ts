export interface ModelPricing {
  inputPerMillionTokensUsd: number;
  outputPerMillionTokensUsd: number;
  cachedInputPerMillionTokensUsd?: number;
}

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
};

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
  const pricing = PRICING[model];
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
