import pino, { type Logger } from 'pino';

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: { service: 'recruiting-os' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.accessToken',
        '*.refreshToken',
        '*.base64',
        '*.rawText',
        '*.encryptedPayload',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
