import { serve } from '@hono/node-server';
import { app } from '@/app';
import { getEnv } from '@/env';

const env = getEnv();

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`pr-cascade listening on http://${info.address}:${info.port}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    console.error(`received ${signal} during shutdown, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`received ${signal}, draining`);
  server.close((err) => {
    if (err) {
      console.error('graceful shutdown failed', err.message);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error('forced exit after 10s drain timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Node 24 treats both as fatal by default. Surface the cause, then drain.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  shutdown('unhandledRejection');
});
