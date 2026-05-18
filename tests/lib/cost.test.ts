import { describe, expect, it } from 'vitest';
import { CostCapExceededError, enforceCostCap, estimateCost } from '@/lib/cost';

const PENNY = 1e-9;

describe('estimateCost', () => {
  it('charges only the input rate when no tokens are cached', () => {
    const cost = estimateCost('gpt-5.3-codex', 1_000_000, 0, 0);
    expect(cost.inputCents).toBeCloseTo(175, 6);
    expect(cost.outputCents).toBe(0);
    expect(cost.cachedInputCents).toBe(0);
    expect(cost.totalCents).toBeCloseTo(175, 6);
  });

  it('charges the output rate per output token', () => {
    const cost = estimateCost('gpt-5.3-codex', 0, 1_000_000, 0);
    expect(cost.inputCents).toBe(0);
    expect(cost.outputCents).toBeCloseTo(1400, 6);
    expect(cost.cachedInputCents).toBe(0);
    expect(cost.totalCents).toBeCloseTo(1400, 6);
  });

  it('bills the cached portion at the cached rate and the fresh portion at the input rate', () => {
    const cost = estimateCost('gpt-5.3-codex', 1_000_000, 0, 400_000);
    // 600k fresh * $1.75 / 1M = $1.05 = 105c
    // 400k cached * $0.175 / 1M = $0.07 = 7c
    expect(cost.inputCents).toBeCloseTo(105, 6);
    expect(cost.cachedInputCents).toBeCloseTo(7, 6);
    expect(cost.totalCents).toBeCloseTo(112, 6);
  });

  it('treats more cached than total tokens as a fully cached prompt', () => {
    const cost = estimateCost('gpt-5.3-codex', 1_000, 0, 5_000);
    expect(cost.inputCents).toBe(0);
    expect(cost.cachedInputCents).toBeCloseTo((5_000 * 0.175) / 10_000, 6);
  });

  it('returns zero across the board for a zero token call', () => {
    const cost = estimateCost('gpt-5.3-codex', 0, 0, 0);
    expect(cost.totalCents).toBe(0);
  });

  it('throws for an unknown model rather than silently zero billing', () => {
    expect(() => estimateCost('not-a-real-model', 100, 100, 0)).toThrow(/No pricing registered/);
  });

  it('total equals the sum of the three components', () => {
    const cost = estimateCost('gpt-5.3-codex', 12_345, 6_789, 4_000);
    const sum = cost.inputCents + cost.outputCents + cost.cachedInputCents;
    expect(Math.abs(cost.totalCents - sum)).toBeLessThan(PENNY);
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
  });
});
