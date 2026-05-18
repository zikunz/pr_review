export interface ModelPricing {
  inputPerMillionTokensUsd: number;
  outputPerMillionTokensUsd: number;
  cachedInputPerMillionTokensUsd?: number;
}

const PRICING: Record<string, ModelPricing> = {
  'gpt-5.3-codex': {
    inputPerMillionTokensUsd: 1.75,
    outputPerMillionTokensUsd: 14,
    cachedInputPerMillionTokensUsd: 0.175,
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
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  const inputDollars = (freshInput * pricing.inputPerMillionTokensUsd) / 1_000_000;
  const outputDollars = (outputTokens * pricing.outputPerMillionTokensUsd) / 1_000_000;
  const cachedRate = pricing.cachedInputPerMillionTokensUsd ?? pricing.inputPerMillionTokensUsd;
  const cachedDollars = (cachedInputTokens * cachedRate) / 1_000_000;
  return {
    inputCents: inputDollars * 100,
    outputCents: outputDollars * 100,
    cachedInputCents: cachedDollars * 100,
    totalCents: (inputDollars + outputDollars + cachedDollars) * 100,
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
