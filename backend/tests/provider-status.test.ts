import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {createTimeScanAdapter} from '../src/services/timescan.js';
import {checkSmtpStatus,checkSmsStatus,checkTimeScanStatus} from '../src/services/provider-status.js';

describe('provider adapter acceptance contracts',()=>{
  afterEach(()=>jest.restoreAllMocks());

  it('verifies TimeScan through the non-mutating health endpoint',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:204}));
    await createTimeScanAdapter('https://timescan.example','account-1','secret-value').verify();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({pathname:'/health',search:'?account=account-1'}),
      expect.objectContaining({method:'HEAD',headers:{accept:'application/json',authorization:'Bearer secret-value'}}),
    );
  });

  it('keeps absent credentials unverified',async()=>{
    await expect(checkSmtpStatus()).resolves.toEqual(expect.objectContaining({provider:'smtp',status:'not_configured'}));
    await expect(checkSmsStatus()).resolves.toEqual(expect.objectContaining({provider:'sms',status:'not_configured'}));
    await expect(checkTimeScanStatus()).resolves.toEqual(expect.objectContaining({provider:'timescan',status:'not_configured'}));
  });
});
