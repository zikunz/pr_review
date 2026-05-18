import { serve } from '@hono/node-server';
import { app } from '@/app';
import { getEnv } from '@/env';

const env = getEnv();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`pr-cascade listening on http://0.0.0.0:${info.port}`);
});
