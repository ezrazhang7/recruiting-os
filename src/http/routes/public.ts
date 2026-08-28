import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../types';
import { appPage, UI_CSS, UI_JS } from '../ui';

export function registerPublicRoutes(
  app: FastifyInstance,
  { config, repository, queue }: AppDependencies,
): void {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await Promise.all([
      repository.listOrganizations(config.defaultTenantId),
      queue.stats(config.defaultTenantId),
    ]);
    return { status: 'ready' };
  });
  app.get('/', async (_request, reply) => reply.type('text/html').send(appPage(config.auth.mode)));
  app.get('/assets/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(UI_CSS),
  );
  app.get('/assets/app.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(UI_JS),
  );
  app.get('/favicon.ico', async (_request, reply) => reply.status(204).send());
}
