import { serve } from '@hono/node-server';
import { app } from '@/app';
import { getEnv } from '@/env';
import { trace } from '@/lib/trace';
import { drainInFlightReviews } from '@/webhook/handler';

const env = getEnv();

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`pr-cascade listening on http://${info.address}:${info.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.error(`received ${signal} during shutdown, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`received ${signal}, draining`);

  // Hard ceiling so a stuck review or a stuck socket cannot block exit
  // indefinitely. Ten seconds is below the Railway grace period and below
  // the typical PaaS per-deploy stop budget.
  setTimeout(() => {
    console.error('forced exit after 10s drain timeout');
    process.exit(1);
  }, 10_000).unref();

  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  try {
    // Drain the HTTP listener first, then snapshot in-flight reviews. The
    // two cannot run in parallel. A webhook whose connection was accepted
    // just before SIGTERM finishes its async handler AFTER the request
    // body read resolves, and that handler calls `scheduleReview` which
    // adds a new promise to the in-flight set. If `drainInFlightReviews`
    // had already taken its snapshot, the late-arriving review would not
    // be awaited and `process.exit(0)` would kill it mid-OpenAI-call.
    await httpClosed;
    await drainInFlightReviews();
    process.exit(0);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('graceful shutdown failed', reason);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
// Node 24 treats both as fatal by default. Route through `trace` so the
// redactor scrubs any secret-shaped substring an upstream library may have
// embedded in the error message or stack before it lands on stdout or disk.
process.on('uncaughtException', (err) => {
  trace({
    event: 'process.uncaught_exception',
    status: 'failed',
    error: err instanceof Error ? err.message : String(err),
    details: { stack: err instanceof Error ? err.stack : undefined },
  });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  trace({
    event: 'process.unhandled_rejection',
    status: 'failed',
    error: reason instanceof Error ? reason.message : String(reason),
    details: { stack: reason instanceof Error ? reason.stack : undefined },
  });
  void shutdown('unhandledRejection');
});
