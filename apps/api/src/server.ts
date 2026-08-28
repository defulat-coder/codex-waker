import { codexThreadRegistry } from '@waker/codex-runtime';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);

/** Disposes Codex thread runtimes before exiting. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  try {
    await codexThreadRegistry.closeAll();
    await app.close();
  } catch (error) {
    app.log.error(error);
  } finally {
    process.exit(0);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Waker API listening on http://${config.HOST}:${config.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
