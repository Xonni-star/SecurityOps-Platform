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
});
