import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const TRACE_DIR = resolve(process.cwd(), 'traces');

export interface TraceRecord {
  ts: string;
  event: string;
  deliveryId?: string;
  prReviewId?: string;
  repoFullName?: string;
  prNumber?: number;
  durationMs?: number;
  costCents?: number;
  model?: string;
  status?: 'ok' | 'failed' | 'skipped';
  error?: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN =
  /token|secret|authorization|password|api[_-]?key|cookie|bearer|credential|private[_-]?key|signing|jwt|session|passphrase|x-hub-signature/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_STRING_CHARS = 4000;

// Defensive redaction. The handler controls what enters `details` today, but any
// future caller passing an error envelope or a raw HTTP response could put a
// credential here. The redactor:
//   - strips keys whose names suggest secrets
//   - caps recursion depth so cyclic shapes do not stack overflow
//   - truncates raw strings
//   - converts well known object types (Date, Error, RegExp, Map, Set, Buffer)
//     to a JSON safe form
//   - drops BigInt values that would otherwise throw inside JSON.stringify
export function redactForTrace(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return REDACTED;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'function':
      return '[Function]';
    case 'symbol':
      return value.toString();
    case 'number':
    case 'boolean':
      return value;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[InvalidDate]' : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return `[Binary ${(value as { byteLength: number }).byteLength}b]`;
  }
  if (value instanceof Map) {
    return redactForTrace(Object.fromEntries(value), depth + 1);
  }
  if (value instanceof Set) {
    return redactForTrace([...value], depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForTrace(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactForTrace(v, depth + 1);
  }
  return out;
}

export function trace(record: Omit<TraceRecord, 'ts'>): void {
  const full: TraceRecord = {
    ts: new Date().toISOString(),
    ...record,
  };
  // The raw error message can include upstream response bodies. Run the
  // redactor over it so anything that looks like a secret key disappears,
  // then cap the length.
  if (full.error) {
    full.error = String(redactForTrace(String(full.error))).slice(0, 2000);
  }
  if (full.details) {
    full.details = redactForTrace(full.details) as Record<string, unknown>;
  }
  try {
    // mkdirSync with recursive: true is idempotent, so no existsSync guard
    // is needed. Restrict trace directory and file permissions because trace
    // records can contain PR titles, bodies, and finding messages.
    mkdirSync(TRACE_DIR, { recursive: true, mode: 0o700 });
    const file = resolve(TRACE_DIR, `${full.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`trace write failed: ${reason}`);
  }
}
