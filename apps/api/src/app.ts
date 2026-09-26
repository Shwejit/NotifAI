import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
