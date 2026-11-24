import fs from 'node:fs/promises';
import path from 'node:path';
import argon2 from 'argon2';
import {describe,expect,it} from '@jest/globals';

describe('database seed authentication',()=>{
  it('uses an Argon2id hash that verifies the documented admin password',async()=>{
    const seed=await fs.readFile(path.join(process.cwd(),'migrations/002_seed.sql'),'utf8');
    const hash=seed.match(/\$argon2id\$[^']+/)?.[0];
    expect(hash).toBeDefined();
    expect(await argon2.verify(hash!,'password')).toBe(true);
  });

  it('disables MFA only for the local seed account and tenant',async()=>{
    const migration=await fs.readFile(path.join(process.cwd(),'migrations/041_disable_seed_admin_mfa.sql'),'utf8');
    expect(migration).toContain("u.email='admin@example.com'");
    expect(migration).toContain("ARRAY[]::text[]");
    expect(migration).toContain('mfa_secret_ciphertext=NULL');
    expect(migration).toContain('mfa_secret_nonce=NULL');
    expect(migration).toContain('mfa_secret_tag=NULL');
    expect(migration).toContain('mfa_enrolled_at=NULL');
  });
});
