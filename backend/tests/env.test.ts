import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {parseAllowedOrigins,parseKeyQrSecret,parseKeyQrSecrets} from '../src/config/env.js';

describe('production CORS configuration',()=>{
  it('requires explicit external origins in production',()=>{
    expect(()=>parseAllowedOrigins('production',undefined)).toThrow('CORS_ORIGIN is required');
    expect(()=>parseAllowedOrigins('production','http://localhost:8080')).toThrow('must not allow localhost');
  });

  it('rejects wildcard and non-origin values',()=>{
    expect(()=>parseAllowedOrigins('production','*')).toThrow('must not contain wildcards');
    expect(()=>parseAllowedOrigins('production','https://example.test/app')).toThrow('origins only');
  });

  it('keeps localhost available only for development',()=>{
    expect(parseAllowedOrigins('development',undefined)).toEqual(['http://localhost:5173']);
    expect(parseAllowedOrigins('production','https://pi.example.test,https://192.168.1.50')).toEqual([
      'https://pi.example.test',
      'https://192.168.1.50',
    ]);
  });
});

describe('key reminder configuration',()=>{
  const original=process.env.KEY_REMINDER_DAYS;
  afterEach(()=>{
    if(original===undefined)delete process.env.KEY_REMINDER_DAYS;
    else process.env.KEY_REMINDER_DAYS=original;
    jest.resetModules();
  });

  it('accepts a supported subset and removes duplicates',async()=>{
    process.env.KEY_REMINDER_DAYS='3,1,3';
    jest.resetModules();
    const {env}=await import('../src/config/env.js');
    expect(env.KEY_REMINDER_DAYS).toEqual([3,1]);
  });

  it('rejects days that the reminder-state constraint cannot store',async()=>{
    process.env.KEY_REMINDER_DAYS='2';
    jest.resetModules();
    await expect(import('../src/config/env.js')).rejects.toThrow('KEY_REMINDER_DAYS');
  });
});

describe('key QR signing secret configuration',()=>{
  const names=['NODE_ENV','CORS_ORIGIN','KEY_QR_SECRET','KEY_QR_SECRET_PREVIOUS','MFA_ENCRYPTION_KEY','BACKUP_SECRET_KEY','WATCHBOOK_HASH_SECRET'];
  const original=new Map(names.map(name=>[name,process.env[name]]));
  const strong='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  afterEach(()=>{
    for(const name of names){
      const value=original.get(name);
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('requires a strong dedicated secret in production and rejects weak values',()=>{
    expect(()=>parseKeyQrSecret('production',undefined)).toThrow('KEY_QR_SECRET is required in production');
    expect(()=>parseKeyQrSecret('production','short')).toThrow('strong random secret');
    expect(()=>parseKeyQrSecret('production','securityops-dev-key-qr-secret')).toThrow('strong random secret');
    expect(()=>parseKeyQrSecret('development','securityops-dev-key-qr-secret')).toThrow('strong random secret');
    expect(()=>parseKeyQrSecret('production','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow('strong random secret');
    expect(parseKeyQrSecret('production',strong)).toEqual({secret:strong,source:'configured'});
  });

  it('requires a configured secret in every persistent environment',()=>{
    expect(()=>parseKeyQrSecret('staging',undefined)).toThrow('KEY_QR_SECRET is required in staging');
    expect(parseKeyQrSecret('development',undefined).source).toBe('ephemeral');
    expect(parseKeyQrSecret('test',undefined).source).toBe('ephemeral');
  });

  it('rejects a QR secret reused from another secret',()=>{
    expect(()=>parseKeyQrSecret('production',strong,[strong])).toThrow('distinct from all other secrets');
    expect(parseKeyQrSecret('production',strong,['another-strong-secret-value-1234567890'])).toEqual({secret:strong,source:'configured'});
  });

  it('validates previous secrets and keeps them verification-only',()=>{
    const previous='abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(parseKeyQrSecrets('production',strong,previous)).toEqual({secrets:[strong,previous],previous:[previous],source:'configured'});
    expect(()=>parseKeyQrSecrets('production',strong,strong)).toThrow('KEY_QR_SECRET_PREVIOUS');
    expect(()=>parseKeyQrSecrets('production',strong,'short')).toThrow('KEY_QR_SECRET_PREVIOUS');
    expect(()=>parseKeyQrSecrets('production',strong,strong,['another-strong-secret-value-1234567890'])).toThrow();
    expect(parseKeyQrSecrets('development',undefined,undefined).secrets).toHaveLength(1);
  });

  it('prevents production startup when the secret is missing',async()=>{
    process.env.NODE_ENV='production';
    process.env.CORS_ORIGIN='https://security.example.test';
    delete process.env.KEY_QR_SECRET;
    jest.resetModules();
    await expect(import('../src/config/env.js')).rejects.toThrow('KEY_QR_SECRET is required in production');
  });

  it('uses a random per-process secret outside production instead of any hardcoded fallback',async()=>{
    const warn=jest.spyOn(console,'warn').mockImplementation(()=>undefined);
    process.env.NODE_ENV='test';
    delete process.env.KEY_QR_SECRET;
    jest.resetModules();
    const {env,keyQrSecret,keyQrSecretSource}=await import('../src/config/env.js');
    expect(keyQrSecretSource).toBe('ephemeral');
    expect(keyQrSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyQrSecret).not.toBe(env.WATCHBOOK_HASH_SECRET??null);
    expect(keyQrSecret).not.toBe(env.BACKUP_SECRET_KEY??null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ephemeral development-only QR secret'));
  });
});
