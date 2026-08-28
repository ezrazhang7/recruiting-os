import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, AuthenticationError, RateLimitError } from '../domain/errors';
import { MetricsRegistry } from '../infrastructure/observability/metrics';
import { headerString, sessionCookieName } from './request-context';
import { registerAuthRoutes } from './routes/auth';
import { registerConnectorRoutes } from './routes/connectors';
import { registerPublicRoutes } from './routes/public';
import { registerRecruitingRoutes } from './routes/recruiting';
import type { AppDependencies } from './types';

export type { AppDependencies } from './types';

const publicPaths = new Set([
  '/',
  '/assets/app.css',
  '/assets/app.js',
  '/favicon.ico',
  '/health/live',
  '/health/ready',
  '/auth/login',
  '/auth/callback',
  '/auth/development',
]);
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, sessionService, rateLimiter } = dependencies;
  const metrics = dependencies.metrics ?? new MetricsRegistry();
  const runtimeDependencies = { ...dependencies, metrics };
  const sessionCookie = sessionCookieName(config);
  const allowedOrigins = new Set(config.allowedOrigins);
  if (config.environment !== 'production') {
    allowedOrigins.add(`http://127.0.0.1:${config.port}`);
    allowedOrigins.add(`http://localhost:${config.port}`);
  }
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'body.base64', 'body.rawText'],
    },
    bodyLimit: config.limits.requestBytes,
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
  });

  await app.register(cookie, { secret: config.auth.sessionSecret, hook: 'onRequest' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new AppError('Origin is not allowed', 403, 'ORIGIN_NOT_ALLOWED'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.observe(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime,
    );
  });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const rate = await rateLimiter.consume(
      `ip:${request.ip}`,
      config.limits.requestsPerMinute,
      60_000,
    );
    reply
      .header('x-ratelimit-remaining', rate.remaining)
      .header('x-ratelimit-reset', Math.ceil(rate.resetAt / 1000));
    if (!rate.allowed) throw new RateLimitError();
    if (
      publicPaths.has(path) ||
      (request.method === 'GET' && /^\/api\/connectors\/[^/]+\/callback$/.test(path)) ||
      request.method === 'OPTIONS'
    )
      return;
    const authentication = await sessionService.authenticate(request.cookies[sessionCookie]);
    if (!authentication) throw new AuthenticationError();
    request.authentication = authentication;
    const userRate = await rateLimiter.consume(
      `user:${authentication.principal.tenantId}:${authentication.principal.userId}`,
      config.limits.requestsPerMinute,
      60_000,
    );
    if (!userRate.allowed) throw new RateLimitError();
    if (unsafeMethods.has(request.method)) {
      const token = headerString(request.headers['x-csrf-token']);
      if (!sessionService.verifyCsrf(authentication, token))
        throw new AppError('CSRF validation failed', 403, 'CSRF_FAILED');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    if (error instanceof ZodError)
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        requestId: request.id,
      });
    if (error instanceof AppError)
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.expose ? error.message : 'Request failed' },
        requestId: request.id,
      });
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
      requestId: request.id,
    });
  });

  registerPublicRoutes(app, runtimeDependencies);
  registerAuthRoutes(app, runtimeDependencies, sessionCookie);
  registerConnectorRoutes(app, runtimeDependencies, sessionCookie);
  registerRecruitingRoutes(app, runtimeDependencies);
  return app;
}
