export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly expose = true,
  ) {
    super(message);
  }
}
export class AuthenticationError extends AppError {
  constructor() {
    super('Authentication required', 401, 'AUTHENTICATION_REQUIRED');
  }
}
export class AuthorizationError extends AppError {
  constructor() {
    super('Not authorized', 403, 'NOT_AUTHORIZED');
  }
}
export class ValidationError extends AppError {
  constructor(message = 'Request validation failed') {
    super(message, 422, 'VALIDATION_FAILED');
  }
}
export class RateLimitError extends AppError {
  constructor() {
    super('Rate limit exceeded', 429, 'RATE_LIMITED');
  }
}
