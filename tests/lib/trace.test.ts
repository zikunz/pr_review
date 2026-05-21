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

  it('caps recursion depth on deeply nested shapes', () => {
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

  it('survives a true self referencing cycle without stack overflow', () => {
    type Cyclic = { self?: Cyclic };
    const a: Cyclic = {};
    a.self = a;
    const start = Date.now();
    const out = redactForTrace(a) as { self?: { self?: unknown } };
    expect(Date.now() - start).toBeLessThan(50);
    // Walk past the recursion cap and assert the leaf collapses to the
    // redaction marker rather than continuing to recurse.
    let cur: unknown = out;
    for (let i = 0; i < 10; i++) {
      if (cur === '[REDACTED]') break;
      cur = (cur as { self?: unknown })?.self;
    }
    expect(cur).toBe('[REDACTED]');
  });

  it('renders a Symbol as its description string', () => {
    expect(redactForTrace(Symbol('hello'))).toBe('Symbol(hello)');
  });

  it('marks an invalid Date instead of emitting an empty object', () => {
    expect(redactForTrace(new Date('not-a-date'))).toBe('[InvalidDate]');
  });

  it('handles a null-prototype object as a plain bag of fields', () => {
    const bag = Object.create(null);
    bag.token = 'secret';
    bag.kept = 'visible';
    const out = redactForTrace(bag) as Record<string, unknown>;
    expect(out.token).toBe('[REDACTED]');
    expect(out.kept).toBe('visible');
  });

  it('redacts an extended sensitive key set', () => {
    const out = redactForTrace({
      credential: 'c',
      private_key: 'p',
      privateKey: 'p',
      signing_key: 's',
      jwt: 'j',
      session: 'sess',
      passphrase: 'pp',
      'x-hub-signature': 'sig',
      kept: 'visible',
    }) as Record<string, unknown>;
    expect(out.credential).toBe('[REDACTED]');
    expect(out.private_key).toBe('[REDACTED]');
    expect(out.privateKey).toBe('[REDACTED]');
    expect(out.signing_key).toBe('[REDACTED]');
    expect(out.jwt).toBe('[REDACTED]');
    expect(out.session).toBe('[REDACTED]');
    expect(out.passphrase).toBe('[REDACTED]');
    expect(out['x-hub-signature']).toBe('[REDACTED]');
    expect(out.kept).toBe('visible');
  });

  it('does not redact camelCase plural-noun keys that just contain a sensitive substring', () => {
    // `inputTokens` etc. are integer counts surfaced from the OpenAI usage
    // payload, not secret strings. The previous unanchored regex over-matched
    // them as "tokens" and replaced the integer value with [REDACTED], which
    // erased real observability data in production traces.
    const out = redactForTrace({
      inputTokens: 1234,
      outputTokens: 567,
      cachedInputTokens: 89,
      tokenizer: 'cl100k_base',
      sessionId: 'public-abc',
    }) as Record<string, unknown>;
    expect(out.inputTokens).toBe(1234);
    expect(out.outputTokens).toBe(567);
    expect(out.cachedInputTokens).toBe(89);
    expect(out.tokenizer).toBe('cl100k_base');
    expect(out.sessionId).toBe('public-abc');
  });

  it('converts a Date to an ISO string instead of an empty object', () => {
    const out = redactForTrace(new Date('2026-05-18T03:04:05.000Z'));
    expect(out).toBe('2026-05-18T03:04:05.000Z');
  });

  it('converts an Error to a name plus message envelope', () => {
    const out = redactForTrace(new Error('boom')) as { name: string; message: string };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
  });

  it('converts a RegExp to its string form', () => {
    expect(redactForTrace(/abc/gi)).toBe('/abc/gi');
  });

  it('converts a Buffer to a length marker rather than indexed bytes', () => {
    const out = redactForTrace(Buffer.from('secret-bytes'));
    expect(out).toBe('[Binary 12b]');
  });

  it('converts a typed array the same way', () => {
    const out = redactForTrace(new Uint8Array([1, 2, 3]));
    expect(out).toBe('[Binary 3b]');
  });

  it('converts a Map to a plain object so it serializes', () => {
    const out = redactForTrace(new Map([['k', 'v']])) as Record<string, unknown>;
    expect(out.k).toBe('v');
  });

  it('converts a Set to an array', () => {
    const out = redactForTrace(new Set([1, 2, 3])) as number[];
    expect(out).toEqual([1, 2, 3]);
  });

  it('converts a BigInt to a string so JSON.stringify does not throw', () => {
    expect(redactForTrace(123n)).toBe('123n');
    expect(() => JSON.stringify(redactForTrace({ id: 123n }))).not.toThrow();
  });

  it('replaces a function reference with a placeholder', () => {
    expect(redactForTrace(() => 1)).toBe('[Function]');
  });

  it('redacts a secret key whose value is a Buffer', () => {
    const out = redactForTrace({ token: Buffer.from('secret') }) as { token: unknown };
    expect(out.token).toBe('[REDACTED]');
  });

  it('redacts an OpenAI key embedded inside a string value', () => {
    const out = redactForTrace('Error: invalid api key sk-proj-abc123XYZ_DEFghijklmnop');
    expect(out).toBe('Error: invalid api key [REDACTED]');
  });

  it('redacts a real-shape sk-proj key that contains hyphens in its body', () => {
    // Modern OpenAI project keys routinely contain hyphens in their
    // body (per the gitleaks and GitGuardian detector regexes). An
    // earlier tightening of this pattern dropped `-` from the body
    // class, which truncated real `sk-proj-` keys at the first hyphen
    // and silently leaked the rest of the live key into traces. This
    // test pins the corrected split-alternation so the FULL key is
    // redacted as a single unit.
    const realShape =
      'sk-proj-T3BlbkFJ_pCAi5l3qE8tIQ1Wm2nB0vXyZ-aBcDeFgHiJkLmNoPqRsTuVwXyZ-ABCDEFGHIJ1234567890';
    expect(redactForTrace(`auth failed for ${realShape}`)).toBe('auth failed for [REDACTED]');
  });

  it('redacts a real-shape sk-svcacct key with hyphens', () => {
    const realShape = 'sk-svcacct-1234567890abcdefghij1234-with-hyphens-too';
    expect(redactForTrace(realShape)).toBe('[REDACTED]');
  });

  it('redacts a real-shape sk-admin key', () => {
    // sk-admin- is the third documented prefix (gitleaks PR 1780).
    const realShape = 'sk-admin-1234567890abcdefghij1234567890-with-hyphens';
    expect(redactForTrace(realShape)).toBe('[REDACTED]');
  });

  it('redacts a GitHub installation token embedded in an error message', () => {
    const out = redactForTrace('Authorization: Bearer ghs_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII');
    expect(out).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts a PEM block embedded in a string', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIICXAIBAAKBgQDc...\n-----END RSA PRIVATE KEY-----';
    const out = redactForTrace(`config error: ${pem}`);
    expect(out).toBe('config error: [REDACTED]');
  });

  it('redacts a full-length GitHub personal access token', () => {
    const out = redactForTrace('auth header had ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII inside');
    expect(out).toBe('auth header had [REDACTED] inside');
  });

  it('redacts a GitHub OAuth token', () => {
    const out = redactForTrace('OAuth: gho_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII');
    expect(out).toBe('OAuth: [REDACTED]');
  });

  it('redacts a GitHub fine-grained personal access token', () => {
    const out = redactForTrace(
      'PAT github_pat_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL trailing',
    );
    expect(out).toBe('PAT [REDACTED] trailing');
  });

  it('does not touch innocuous strings that just contain sk- or ghp_ as substring', () => {
    expect(redactForTrace('sk-mini test fixture')).toBe('sk-mini test fixture');
    expect(redactForTrace('ghp_short')).toBe('ghp_short');
  });

  it('does not redact a URL path or error message that contains sk- followed by hyphenated words', () => {
    // Real OpenAI keys are alphanumeric-with-underscore after the documented
    // prefix. The pattern must not over-match on innocuous strings that
    // happen to start with `sk-` and contain hyphens, such as URL path
    // fragments or route-handler identifiers in error messages.
    expect(redactForTrace('sk-line-of-text-with-no-actual-secret-here')).toBe(
      'sk-line-of-text-with-no-actual-secret-here',
    );
    expect(redactForTrace('sk-fake-1234567890abcdef-fake')).toBe('sk-fake-1234567890abcdef-fake');
    expect(redactForTrace('GET /api/sk-route-handler-not-found 404')).toBe(
      'GET /api/sk-route-handler-not-found 404',
    );
  });
});
