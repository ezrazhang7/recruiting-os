import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import { AuthenticationError } from '../domain/errors';
import { stableId } from '../lib/util';

export const PRODUCTION_SESSION_COOKIE = '__Host-recruiting_session';
export const DEVELOPMENT_SESSION_COOKIE = 'recruiting_session';
export const CSRF_COOKIE = 'recruiting_csrf';
export const OIDC_COOKIE = 'recruiting_oidc_state';
export const PROVIDER_COOKIE = 'recruiting_provider_state';

export function sessionCookieName(config: AppConfig): string {
  return config.environment === 'production'
    ? PRODUCTION_SESSION_COOKIE
    : DEVELOPMENT_SESSION_COOKIE;
}

export function authentication(request: FastifyRequest) {
  if (!request.authentication) throw new AuthenticationError();
  return request.authentication;
}

export function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function idempotencyKey(request: FastifyRequest, body: unknown): string {
  return (
    headerString(request.headers['x-idempotency-key']) ??
    stableId(
      'idem',
      `${authentication(request).principal.userId}:${JSON.stringify(body)}:${Math.floor(Date.now() / 300_000)}`,
    )
  );
}

export function setSignedCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
  path = '/auth',
): void {
  reply.setCookie(name, value, {
    path,
    httpOnly: true,
    secure,
    sameSite: 'lax',
    signed: true,
    maxAge,
  });
}

export function setSessionCookies(
  reply: FastifyReply,
  cookieName: string,
  token: string,
  csrf: string,
  secure: boolean,
  maxAge: number,
): void {
  reply.setCookie(cookieName, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: '/',
    httpOnly: false,
    secure,
    sameSite: 'strict',
    maxAge,
  });
}
