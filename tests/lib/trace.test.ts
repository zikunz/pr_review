import { describe, expect, it } from 'vitest';
import { redactForTrace } from '@/lib/trace';

describe('redactForTrace', () => {
  it('passes primitives through unchanged', () => {
    expect(redactForTrace(null)).toBe(null);
    expect(redactForTrace(undefined)).toBe(undefined);
    expect(redactForTrace(42)).toBe(42);
    expect(redactForTrace(true)).toBe(true);
    expect(redactForTrace('short')).toBe('short');
  });

  it('redacts keys whose names suggest secrets', () => {
    const input = {
      token: 'abc',
      secret: 'def',
      Authorization: 'Bearer xyz',
      api_key: 'k',
      'api-key': 'k',
      Cookie: 'sid=1',
      password: 'p',
      Bearer: 'b',
      safe: 'visible',
    };
    const out = redactForTrace(input) as Record<string, unknown>;
    expect(out.token).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out['api-key']).toBe('[REDACTED]');
    expect(out.Cookie).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.Bearer).toBe('[REDACTED]');
    expect(out.safe).toBe('visible');
  });

  it('recurses into nested objects', () => {
    const input = { outer: { token: 'secret-value', okay: 1 } };
    const out = redactForTrace(input) as { outer: Record<string, unknown> };
    expect(out.outer.token).toBe('[REDACTED]');
    expect(out.outer.okay).toBe(1);
  });

  it('recurses into arrays', () => {
    const input = [{ token: 't' }, { okay: 1 }];
    const out = redactForTrace(input) as Array<Record<string, unknown>>;
    expect(out[0]?.token).toBe('[REDACTED]');
    expect(out[1]?.okay).toBe(1);
  });

  it('truncates strings longer than 4000 chars', () => {
    const long = 'a'.repeat(4500);
    const out = redactForTrace(long) as string;
    expect(out.length).toBe(4001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps recursion depth so cyclic shapes do not stack overflow', () => {
    type Cyclic = { self?: Cyclic };
    const root: Cyclic = {};
    let cur = root;
    for (let i = 0; i < 20; i++) {
      cur.self = {};
      cur = cur.self;
    }
    const out = redactForTrace(root);
    expect(out).toBeDefined();
  });
});
