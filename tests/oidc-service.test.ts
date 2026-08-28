import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validatedDiscovery,
  verifiedIdentityClaims,
} from '../src/infrastructure/auth/oidc-service';
import { safeRelativeReturnTo } from '../src/lib/safe-url';

test('OIDC identity accepts only a verified institutional email and a stable subject', () => {
  assert.deepEqual(
    verifiedIdentityClaims(
      {
        sub: 'student-123',
        email: 'Student@unc.edu',
        email_verified: true,
        name: 'Student Name',
      },
      'https://idp.example',
      'unc.edu',
    ),
    {
      issuer: 'https://idp.example',
      subject: 'student-123',
      email: 'Student@unc.edu',
      displayName: 'Student Name',
    },
  );
  assert.throws(
    () =>
      verifiedIdentityClaims(
        { sub: 'student-123', email: 'student@unc.edu', email_verified: false },
        'https://idp.example',
        'unc.edu',
      ),
    /Verified email/,
  );
  assert.throws(
    () =>
      verifiedIdentityClaims(
        { sub: '', email: 'student@unc.edu', email_verified: true },
        'https://idp.example',
        'unc.edu',
      ),
    /subject is missing/,
  );
  assert.throws(
    () =>
      verifiedIdentityClaims(
        { sub: 'student-123', email: 'student@example.edu', email_verified: true },
        'https://idp.example',
        'unc.edu',
      ),
    /domain is not allowed/,
  );
});

test('OIDC discovery and post-login redirects require secure local destinations', () => {
  assert.equal(safeRelativeReturnTo('/dashboard?tab=current'), '/dashboard?tab=current');
  assert.equal(safeRelativeReturnTo('//evil.example'), '/');
  assert.equal(safeRelativeReturnTo('/\\evil.example'), '/');
  assert.throws(
    () =>
      validatedDiscovery(
        {
          issuer: 'https://idp.example',
          authorization_endpoint: 'https://idp.example/authorize',
          token_endpoint: 'http://idp.example/token',
          jwks_uri: 'https://idp.example/keys',
        },
        'https://idp.example',
      ),
    /credential-free HTTPS URL/,
  );
});
