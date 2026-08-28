import { z } from 'zod';

const booleanFromString = z.preprocess((value) => value === true || value === 'true', z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4318),
  DATABASE_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_PATH: z.string().default('./data/recruiting-os.sqlite'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  AUTH_MODE: z.enum(['oidc', 'development']).default('development'),
  SESSION_SECRET: z.string().min(32).default('development-only-session-secret-change-me'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(43_200),
  CREDENTIAL_MASTER_KEY: z.string().default(Buffer.alloc(32).toString('base64')),
  CREDENTIAL_KEY_VERSION: z.string().default('v1'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_ALLOWED_EMAIL_DOMAIN: z.string().default('unc.edu'),
  DEFAULT_TENANT_ID: z.string().min(1).default('unc'),
  ALLOWED_ORIGINS: z.string().default(''),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(1_000_000),
  MAX_SCREENSHOT_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(5_000_000),
  MAX_FETCH_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(2_000_000),
  MAX_PROVIDER_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(20_000_000)
    .default(6_000_000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  AUTH_IP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(2_000),
  AUTHENTICATED_IP_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(30_000),
  CONNECTOR_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(900),
  TRUST_PROXY: booleanFromString.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_BEARER_TOKEN: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GROUPME_CLIENT_ID: z.string().optional(),
  GROUPME_CLIENT_SECRET: z.string().optional(),
  GROUPME_REDIRECT_URI: z.string().url().optional(),
  META_CLIENT_ID: z.string().optional(),
  META_CLIENT_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().url().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().url().optional(),
  GMAIL_USER_ID: z.string().default('me'),
  META_API_VERSION: z.string().default('v24.0'),
  META_IG_USER_ID: z.string().optional(),
  LINKEDIN_VERSION: z.string().default('202608'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  if (value.NODE_ENV === 'production') {
    if (value.DATABASE_DRIVER !== 'postgres' || !value.DATABASE_URL) {
      throw new Error('Production requires DATABASE_DRIVER=postgres and DATABASE_URL');
    }
    if (value.AUTH_MODE !== 'oidc') throw new Error('Production requires AUTH_MODE=oidc');
    if (!value.OIDC_ISSUER || !value.OIDC_CLIENT_ID || !value.OIDC_REDIRECT_URI) {
      throw new Error('Production OIDC configuration is incomplete');
    }
    if (value.SESSION_SECRET.includes('development-only')) {
      throw new Error('Production SESSION_SECRET must be changed');
    }
    if (value.CREDENTIAL_MASTER_KEY === Buffer.alloc(32).toString('base64')) {
      throw new Error('Production CREDENTIAL_MASTER_KEY must be changed');
    }
    if (!value.METRICS_BEARER_TOKEN) {
      throw new Error('Production METRICS_BEARER_TOKEN is required');
    }
    const allowedOrigins = value.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (
      !allowedOrigins.length ||
      allowedOrigins.some((origin) => new URL(origin).protocol !== 'https:')
    )
      throw new Error('Production requires explicit HTTPS ALLOWED_ORIGINS');
  }
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    database: {
      driver: value.DATABASE_DRIVER,
      url: value.DATABASE_URL,
      path: value.DATABASE_PATH,
      poolSize: value.DATABASE_POOL_SIZE,
    },
    auth: {
      mode: value.AUTH_MODE,
      sessionSecret: value.SESSION_SECRET,
      sessionTtlSeconds: value.SESSION_TTL_SECONDS,
      credentialMasterKey: value.CREDENTIAL_MASTER_KEY,
      credentialKeyVersion: value.CREDENTIAL_KEY_VERSION,
      issuer: value.OIDC_ISSUER,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      redirectUri: value.OIDC_REDIRECT_URI,
      allowedEmailDomain: value.OIDC_ALLOWED_EMAIL_DOMAIN,
    },
    defaultTenantId: value.DEFAULT_TENANT_ID,
    allowedOrigins: value.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    openai: { apiKey: value.OPENAI_API_KEY ?? '', model: value.OPENAI_MODEL },
    limits: {
      requestBytes: value.MAX_REQUEST_BYTES,
      screenshotBytes: value.MAX_SCREENSHOT_BYTES,
      fetchBytes: value.MAX_FETCH_BYTES,
      providerResponseBytes: value.MAX_PROVIDER_RESPONSE_BYTES,
      requestsPerMinute: value.RATE_LIMIT_PER_MINUTE,
      authIpRequestsPerMinute: value.AUTH_IP_RATE_LIMIT_PER_MINUTE,
      authenticatedIpRequestsPerMinute: value.AUTHENTICATED_IP_RATE_LIMIT_PER_MINUTE,
      connectorSyncIntervalSeconds: value.CONNECTOR_SYNC_INTERVAL_SECONDS,
    },
    trustProxy: value.TRUST_PROXY,
    logLevel: value.LOG_LEVEL,
    observability: { metricsBearerToken: value.METRICS_BEARER_TOKEN },
    providers: {
      gmail: {
        clientId: value.GOOGLE_CLIENT_ID,
        clientSecret: value.GOOGLE_CLIENT_SECRET,
        redirectUri: value.GOOGLE_REDIRECT_URI,
      },
      groupme: {
        clientId: value.GROUPME_CLIENT_ID,
        clientSecret: value.GROUPME_CLIENT_SECRET,
        redirectUri: value.GROUPME_REDIRECT_URI,
      },
      instagram: {
        clientId: value.META_CLIENT_ID,
        clientSecret: value.META_CLIENT_SECRET,
        redirectUri: value.META_REDIRECT_URI,
      },
      linkedin: {
        clientId: value.LINKEDIN_CLIENT_ID,
        clientSecret: value.LINKEDIN_CLIENT_SECRET,
        redirectUri: value.LINKEDIN_REDIRECT_URI,
      },
    },
    connectorRuntime: {
      gmailUserId: value.GMAIL_USER_ID,
      metaApiVersion: value.META_API_VERSION,
      metaIgUserId: value.META_IG_USER_ID,
      linkedinVersion: value.LINKEDIN_VERSION,
    },
  } as const;
}
