import {describe,expect,it} from '@jest/globals';
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
