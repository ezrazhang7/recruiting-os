import { createHash, randomBytes } from 'node:crypto';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}
export interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}
export interface OidcClaims {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
}
export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  allowedEmailDomain: string;
}
export class OidcService {
  private discovery?: Promise<Discovery>;
  constructor(private readonly options: OidcOptions) {}
  async authorization(returnTo = '/'): Promise<{ url: string; state: OidcState }> {
    const discovery = await this.getDiscovery();
    const state: OidcState = {
      state: randomBytes(24).toString('base64url'),
      nonce: randomBytes(24).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      returnTo: returnTo.startsWith('/') ? returnTo : '/',
    };
    const challenge = createHash('sha256').update(state.verifier).digest('base64url');
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state.state);
    url.searchParams.set('nonce', state.nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }
  async callback(code: string, state: OidcState): Promise<OidcClaims> {
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      code_verifier: state.verifier,
    });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!tokenResponse.ok) throw new Error(`OIDC token exchange failed: ${tokenResponse.status}`);
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('OIDC response did not include an ID token');
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: discovery.issuer,
      audience: this.options.clientId,
    });
    if (payload.nonce !== state.nonce) throw new Error('OIDC nonce mismatch');
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (
      !email ||
      !email.toLowerCase().endsWith(`@${this.options.allowedEmailDomain.toLowerCase()}`)
    )
      throw new Error('Email domain is not allowed');
    return {
      issuer: discovery.issuer,
      subject: String(payload.sub),
      email,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
  private async getDiscovery(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const issuer = this.options.issuer.replace(/\/$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
        const value = (await response.json()) as Discovery;
        if (value.issuer !== issuer) throw new Error('OIDC issuer mismatch');
        return value;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.discovery;
  }
}
