import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialRepository, StoredCredential } from '../src/application/ports/credential-repository';
import { EncryptedCredentialVault } from '../src/infrastructure/credentials/encrypted-credential-vault';

class MemoryCredentials implements CredentialRepository {
  value?:StoredCredential;async save(value:StoredCredential){this.value=value;}async find(){return this.value;}async revoke(){if(this.value)this.value={...this.value,revokedAt:new Date().toISOString()};}async close(){}
}
test('provider credentials are authenticated-encrypted and revocable',async()=>{
  const repository=new MemoryCredentials();const vault=new EncryptedCredentialVault(repository,Buffer.alloc(32,7).toString('base64'),'v1');
  await vault.put('tenant','user','gmail',{accessToken:'secret-access',refreshToken:'secret-refresh',scopes:['gmail.readonly']});
  assert.ok(repository.value);assert.equal(repository.value.encryptedPayload.includes(Buffer.from('secret-access')),false);
  assert.equal((await vault.get('tenant','user','gmail'))?.refreshToken,'secret-refresh');await vault.revoke('tenant','user','gmail');assert.equal(await vault.get('tenant','user','gmail'),undefined);
});

test('credential ciphertext is bound to tenant, user, and provider',async()=>{
  const repository=new MemoryCredentials();const vault=new EncryptedCredentialVault(repository,Buffer.alloc(32,7).toString('base64'),'v1');await vault.put('tenant-a','user','gmail',{accessToken:'secret',scopes:[]});
  await assert.rejects(()=>vault.get('tenant-b','user','gmail'));
});
