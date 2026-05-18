import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

const SENSITIVE_KEY_PATTERN = /token|secret|authorization|password|api[_-]?key|cookie|bearer/i;
const REDACTED = '[REDACTED]';

// Defensive redaction. The handler controls what enters `details` today, but any
// future caller passing an error envelope or a raw HTTP response could put a
// credential here. Strip keys whose names suggest secrets and truncate raw
// strings that look long enough to embed one.
export function redactForTrace(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactForTrace(item, depth + 1));
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
  if (full.error) full.error = String(full.error).slice(0, 2000);
  if (full.details) {
    full.details = redactForTrace(full.details) as Record<string, unknown>;
  }
  try {
    if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
    const file = resolve(TRACE_DIR, `${full.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`trace write failed: ${reason}`);
  }
}
