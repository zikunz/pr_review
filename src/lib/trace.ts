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

export function trace(record: Omit<TraceRecord, 'ts'>): void {
  const full: TraceRecord = {
    ts: new Date().toISOString(),
    ...record,
  };
  try {
    if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
    const file = resolve(TRACE_DIR, `${full.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`trace write failed: ${reason}`);
  }
}
