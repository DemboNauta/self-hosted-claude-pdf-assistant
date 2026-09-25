import { assertNoApiKey } from './auth-guard.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { LOG_PREFIX } from './log.js';

try {
  // Must run before anything touches Claude (SPEC §6.3).
  assertNoApiKey();
} catch (err) {
  console.error(`${LOG_PREFIX} ${(err as Error).message}`);
  process.exit(1);
}

const config = loadConfig();
const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
