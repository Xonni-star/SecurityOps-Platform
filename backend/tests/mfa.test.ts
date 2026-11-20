import {describe,expect,it} from '@jest/globals';
import {totpCode,totpStep,verifyTotp} from '../src/services/mfa.js';

describe('TOTP MFA primitives',()=>{
  it('matches the RFC 6238 SHA-1 vector at six digits',()=>{
    const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpCode(secret,totpStep(59000))).toBe('287082');
  });
  it('accepts one adjacent time step but rejects malformed codes',()=>{
    const timestamp=1_700_000_000_000;
    const step=totpStep(timestamp);
    expect(verifyTotp('JBSWY3DPEHPK3PXP',totpCode('JBSWY3DPEHPK3PXP',step+1),timestamp)).toBe(step+1);
    expect(verifyTotp('JBSWY3DPEHPK3PXP','12345',timestamp)).toBeNull();
  });
  it('does not expose secret material through the generated code',()=>{
    expect(totpCode('JBSWY3DPEHPK3PXP')).toMatch(/^\d{6}$/);
    expect(totpCode('JBSWY3DPEHPK3PXP')).not.toContain('JBSWY3DPEHPK3PXP');
  });
});
