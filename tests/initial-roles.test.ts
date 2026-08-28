import assert from 'node:assert/strict';
import test from 'node:test';
import { initialRolesForIdentity } from '../src/application/auth/initial-roles';
import { SqliteAuthRepository } from '../src/infrastructure/auth/sqlite-auth-repository';
import { Store } from '../src/store';

test('only an exact verified-email bootstrap entry receives the initial admin role', () => {
  const allowlist = ['operator@unc.edu'];
  assert.deepEqual(initialRolesForIdentity('Operator@unc.edu', allowlist), ['platform_admin']);
  assert.deepEqual(initialRolesForIdentity('student@unc.edu', allowlist), ['student']);
  assert.deepEqual(initialRolesForIdentity(undefined, allowlist), ['student']);
});

test('a bootstrap login can promote an existing student membership', async () => {
  const store = new Store();
  const auth = new SqliteAuthRepository(store);
  const identity = {
    issuer: 'https://idp.example',
    subject: 'existing-student',
    email: 'operator@unc.edu',
  };
  const userId = await auth.upsertIdentity(identity, 'unc', ['student']);
  await auth.upsertIdentity(identity, 'unc', ['platform_admin']);
  const roles = JSON.parse(
    (
      store.db
        .prepare('select roles from memberships where tenant_id=? and user_id=?')
        .get('unc', userId) as { roles: string }
    ).roles,
  );
  assert.deepEqual(roles.sort(), ['platform_admin', 'student']);
  await store.close();
});
