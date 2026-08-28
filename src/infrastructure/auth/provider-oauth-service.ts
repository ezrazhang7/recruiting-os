import { createHash, randomBytes } from 'node:crypto';
import type { ProviderCredential } from '../../application/ports/credential-vault';
import { safeRelativeReturnTo } from '../../lib/safe-url';
import { boundedResponse } from '../outbound-http/bounded-response';

const maxTokenResponseBytes = 64 * 1024;

export type OAuthProvider = 'gmail' | 'groupme' | 'instagram' | 'linkedin';
export interface ProviderOAuthState {
  provider: OAuthProvider;
  state: string;
  verifier: string;
  userId: string;
  tenantId: string;
  returnTo: string;
}
interface ProviderDefinition {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  extra?: Record<string, string>;
}
export type ProviderConfiguration = Partial<
  Record<OAuthProvider, { clientId?: string; clientSecret?: string; redirectUri?: string }>
>;

const endpoints: Record<
  OAuthProvider,
  Omit<ProviderDefinition, 'clientId' | 'clientSecret' | 'redirectUri'>
> = {
  gmail: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  groupme: {
    authorizationEndpoint: 'https://oauth.groupme.com/oauth/authorize',
    tokenEndpoint: 'https://api.groupme.com/oauth/access_token',
    scopes: [],
  },
  instagram: {
    authorizationEndpoint: 'https://www.facebook.com/v24.0/dialog/oauth',
    tokenEndpoint: 'https://graph.facebook.com/v24.0/oauth/access_token',
    scopes: ['instagram_basic', 'pages_read_engagement'],
  },
  linkedin: {
    authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['r_organization_social'],
  },
};
export class ProviderOAuthService {
  constructor(
    private readonly configuration: ProviderConfiguration,
    private readonly transport: typeof fetch = fetch,
  ) {}
  authorization(
    provider: OAuthProvider,
    userId: string,
    tenantId: string,
    returnTo = '/?connectors=1',
  ): { url: string; state: ProviderOAuthState } {
    const definition = this.definition(provider);
    const state: ProviderOAuthState = {
      provider,
      state: randomBytes(24).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      userId,
      tenantId,
      returnTo: safeRelativeReturnTo(returnTo, '/?connectors=1'),
    };
    const challenge = createHash('sha256').update(state.verifier).digest('base64url');
    const url = new URL(definition.authorizationEndpoint);
    url.searchParams.set('client_id', definition.clientId);
    url.searchParams.set('redirect_uri', definition.redirectUri);
    url.searchParams.set('response_type', 'code');
    if (definition.scopes.length) url.searchParams.set('scope', definition.scopes.join(' '));
    url.searchParams.set('state', state.state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(definition.extra ?? {}))
      url.searchParams.set(key, value);
    return { url: url.toString(), state };
  }
  async callback(
    provider: OAuthProvider,
    code: string,
    state: ProviderOAuthState,
  ): Promise<ProviderCredential> {
    if (provider !== state.provider) throw new Error('OAuth provider mismatch');
    const definition = this.definition(provider);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: definition.clientId,
      redirect_uri: definition.redirectUri,
      code_verifier: state.verifier,
    });
    if (definition.clientSecret) body.set('client_secret', definition.clientSecret);
    const token = await this.requestToken(definition.tokenEndpoint, body);
    if (!token.access_token) throw new Error('Provider did not return an access token');
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : undefined,
      scopes: token.scope ? token.scope.split(/[ ,]+/).filter(Boolean) : definition.scopes,
    };
  }
  async refresh(
    provider: OAuthProvider,
    credential: ProviderCredential,
  ): Promise<ProviderCredential> {
    if (!credential.refreshToken)
      throw new Error(`${provider} credential expired and cannot be refreshed`);
    const definition = this.definition(provider);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: definition.clientId,
    });
    if (definition.clientSecret) body.set('client_secret', definition.clientSecret);
    const token = await this.requestToken(definition.tokenEndpoint, body);
    if (!token.access_token) throw new Error('Provider refresh did not return an access token');
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credential.refreshToken,
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : credential.expiresAt,
      scopes: token.scope ? token.scope.split(/[ ,]+/).filter(Boolean) : credential.scopes,
      metadata: credential.metadata,
    };
  }
  configured(provider: OAuthProvider): boolean {
    const value = this.configuration[provider];
    return Boolean(value?.clientId && value.redirectUri);
  }
  private async requestToken(
    tokenEndpoint: string,
    body: URLSearchParams,
  ): Promise<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await this.transport(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Provider token exchange failed: ${response.status}`);
    }
    const bounded = await boundedResponse(response, maxTokenResponseBytes);
    return (await bounded.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }
  private definition(provider: OAuthProvider): ProviderDefinition {
    const value = this.configuration[provider];
    if (!value?.clientId || !value.redirectUri)
      throw new Error(`${provider} OAuth is not configured`);
    return {
      ...endpoints[provider],
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      redirectUri: value.redirectUri,
    };
  }
}
