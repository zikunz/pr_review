import { describe, expect, it } from 'vitest';
import { CostCapExceededError, enforceCostCap, estimateCost, normalizeModel } from '@/lib/cost';

const FLOAT_EPSILON_CENTS = 1e-9;

describe('estimateCost', () => {
  it('charges only the input rate when no tokens are cached', () => {
    // 1M tokens at $0.75/M = $0.75 = 75 cents.
    const cost = estimateCost('gpt-5.4-mini', 1_000_000, 0, 0);
    expect(cost.inputCents).toBeCloseTo(75, 6);
    expect(cost.outputCents).toBe(0);
    expect(cost.cachedInputCents).toBe(0);
    expect(cost.totalCents).toBeCloseTo(75, 6);
  });

  it('charges the output rate per output token', () => {
    // 1M tokens at $4.50/M = $4.50 = 450 cents.
    const cost = estimateCost('gpt-5.4-mini', 0, 1_000_000, 0);
    expect(cost.inputCents).toBe(0);
    expect(cost.outputCents).toBeCloseTo(450, 6);
    expect(cost.cachedInputCents).toBe(0);
    expect(cost.totalCents).toBeCloseTo(450, 6);
  });

  it('bills the cached portion at the cached rate and the fresh portion at the input rate', () => {
    const cost = estimateCost('gpt-5.4-mini', 1_000_000, 0, 400_000);
    // 600k fresh at $0.75/M = $0.45 = 45c.
    // 400k cached at $0.075/M = $0.03 = 3c.
    expect(cost.inputCents).toBeCloseTo(45, 6);
    expect(cost.cachedInputCents).toBeCloseTo(3, 6);
    expect(cost.totalCents).toBeCloseTo(48, 6);
  });

  it('treats more cached than total tokens as a fully cached prompt', () => {
    const cost = estimateCost('gpt-5.4-mini', 1_000, 0, 5_000);
    // 5_000 tokens at the $0.075/M cached rate = $0.000375 = 0.0375 cents.
    expect(cost.inputCents).toBe(0);
    expect(cost.cachedInputCents).toBeCloseTo(0.0375, 6);
  });

  it('bills input, output, and cached input simultaneously', () => {
    const cost = estimateCost('gpt-5.4-mini', 12_345, 6_789, 4_000);
    // fresh = 12345 - 4000 = 8345 input tokens at $0.75/M = 0.625875 cents.
    // 6789 output tokens at $4.50/M = 3.05505 cents.
    // 4000 cached at $0.075/M = 0.03 cents.
    expect(cost.inputCents).toBeCloseTo(0.625875, 6);
    expect(cost.outputCents).toBeCloseTo(3.05505, 6);
    expect(cost.cachedInputCents).toBeCloseTo(0.03, 6);
    expect(cost.totalCents).toBeCloseTo(3.710925, 6);
  });

  it('returns zero across the board for a zero token call', () => {
    const cost = estimateCost('gpt-5.4-mini', 0, 0, 0);
    expect(cost.totalCents).toBe(0);
  });

  it('throws for an unknown model rather than silently zero billing', () => {
    expect(() => estimateCost('not-a-real-model', 100, 100, 0)).toThrow(/No pricing registered/);
  });

  it('normalizeModel strips a provider prefix and passes bare names through', () => {
    expect(normalizeModel('openai/gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(normalizeModel('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
    expect(normalizeModel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  it('has pricing registered for every cascade tier model', () => {
    // Each tier is exercised so a future pricing-table edit cannot drop a
    // model without the test suite flagging it.
    expect(() => estimateCost('gpt-5.4-mini', 1, 1, 0)).not.toThrow();
    expect(() => estimateCost('gpt-5.4', 1, 1, 0)).not.toThrow();
    expect(() => estimateCost('gpt-5.5', 1, 1, 0)).not.toThrow();
  });

  it('prices a provider-prefixed (OpenRouter) model name the same as the bare name', () => {
    // OpenRouter returns model names like `openai/gpt-5.4-mini`. The pricing
    // lookup strips the provider prefix, so the cost must match the bare name.
    const bare = estimateCost('gpt-5.4-mini', 10_000, 5_000, 0);
    const prefixed = estimateCost('openai/gpt-5.4-mini', 10_000, 5_000, 0);
    expect(prefixed.totalCents).toBeCloseTo(bare.totalCents, 9);
  });

  it('still throws for a provider-prefixed unknown model', () => {
    expect(() => estimateCost('openai/not-a-real-model', 100, 100, 0)).toThrow(
      /No pricing registered/,
    );
  });

  it('total equals the sum of the three components', () => {
    const cost = estimateCost('gpt-5.4-mini', 12_345, 6_789, 4_000);
    const sum = cost.inputCents + cost.outputCents + cost.cachedInputCents;
    expect(Math.abs(cost.totalCents - sum)).toBeLessThan(FLOAT_EPSILON_CENTS);
  });
});

describe('enforceCostCap', () => {
  it('is a no-op when actual is below the cap', () => {
    expect(() => enforceCostCap(29.99, 30)).not.toThrow();
  });

  it('is a no-op when actual equals the cap', () => {
    expect(() => enforceCostCap(30, 30)).not.toThrow();
  });

  it('throws CostCapExceededError when actual is above the cap', () => {
    let thrown: unknown;
    try {
      enforceCostCap(30.01, 30);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CostCapExceededError);
    expect((thrown as CostCapExceededError).actualCents).toBe(30.01);
    expect((thrown as CostCapExceededError).capCents).toBe(30);
    expect((thrown as CostCapExceededError).message).toContain('exceeds cap');
  });
});
