import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {parseAllowedOrigins} from '../src/config/env.js';

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
