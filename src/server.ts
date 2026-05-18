import { serve } from '@hono/node-server';
import { app } from '@/app';
import { getEnv } from '@/env';

const env = getEnv();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`pr-cascade listening on http://0.0.0.0:${info.port}`);
});

function shutdown(signal: string): void {
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
