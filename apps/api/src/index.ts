import { buildApp } from './app.js';
import { config } from './config.js';

const app = buildApp();

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'Failed to start API');
  process.exitCode = 1;
}
