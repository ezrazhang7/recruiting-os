import 'fastify';
import type { SessionAuthentication } from '../application/ports/auth-repository';

declare module 'fastify' {
  interface FastifyRequest {
    authentication?: SessionAuthentication;
  }
}
