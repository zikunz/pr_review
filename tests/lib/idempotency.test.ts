import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '@/lib/idempotency';

describe('IdempotencyStore', () => {
  it('returns false for an unknown key', () => {
    const store = new IdempotencyStore();
    expect(store.has('never-seen')).toBe(false);
  });

  it('returns true after remember', () => {
    const store = new IdempotencyStore();
    store.remember('abc');
    expect(store.has('abc')).toBe(true);
  });

  it('expires entries after TTL elapses', () => {
    let now = 1000;
    const store = new IdempotencyStore(() => now, 100);
    store.remember('abc');
    now += 101;
    expect(store.has('abc')).toBe(false);
  });

  it('treats entries inside TTL as present', () => {
    let now = 1000;
    const store = new IdempotencyStore(() => now, 100);
    store.remember('abc');
    now += 50;
    expect(store.has('abc')).toBe(true);
  });

  it('different keys remain independent', () => {
    const store = new IdempotencyStore();
    store.remember('first');
    expect(store.has('first')).toBe(true);
    expect(store.has('second')).toBe(false);
  });

  it('tracks size for remembered entries', () => {
    const store = new IdempotencyStore();
    expect(store.size()).toBe(0);
    store.remember('a');
    store.remember('b');
    expect(store.size()).toBe(2);
  });
});
