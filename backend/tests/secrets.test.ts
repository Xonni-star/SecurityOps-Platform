import {encryptSecretPayload} from '../src/services/backup-domain.js';
import {resolveSecret,resolveSecretPayload} from '../src/services/secrets.js';

describe('secret resolution',()=>{
  it('resolves JSON references without exposing absent values',async()=>{
    await expect(resolveSecretPayload('SFTP_SECRET',null,()=>JSON.stringify({username:'guard',privateKey:'KEY',passphrase:'PASS'}))).resolves.toEqual({username:'guard',privateKey:'KEY',passphrase:'PASS'});
    await expect(resolveSecretPayload('MISSING',null,()=>undefined)).rejects.toThrow('unavailable');
  });
  it('rejects invalid referenced payloads and decrypts encrypted payloads',async()=>{
    await expect(resolveSecretPayload('BAD',null,()=>JSON.stringify({username:''}))).rejects.toThrow('invalid payload');
    const encrypted=encryptSecretPayload({accessKey:'access',secretKey:'secret'},'test-key');
    process.env.BACKUP_SECRET_KEY='test-key';
    await expect(resolveSecretPayload(undefined,encrypted,undefined)).resolves.toEqual({accessKey:'access',secretKey:'secret'});
    delete process.env.BACKUP_SECRET_KEY;
    await expect(resolveSecretPayload(undefined,encrypted,undefined)).rejects.toThrow('key is unavailable');
    await expect(resolveSecret('EMPTY',()=>'' )).rejects.toThrow('unavailable');
  });
});
