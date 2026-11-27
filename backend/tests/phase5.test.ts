import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const listWorkTimes=jest.fn(async()=>[{externalId:'shift-1',employeeEmail:'worker@example.com',startedAt:'2026-11-19T08:00:00Z',endedAt:'2026-11-19T16:00:00Z',minutes:480}]);
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
jest.unstable_mockModule('../src/services/timescan.js',()=>({createTimeScanAdapter:jest.fn(()=>({listWorkTimes}))}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'00000000-0000-0000-0000-000000000001',tenantId:'00000000-0000-0000-0000-000000000010',email:'admin@example.com',role:'admin',permissions:['reports:read','timescan:read','timescan:write','audit:read','privacy:write','backup:read','backup:manage','providers:read','settings:read','settings:write']};
const session={...user,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>{queryMock.mockReset();process.env.TIMESCAN_TEST_SECRET='secret';});

describe('phase 5 reporting',()=>{
  it('returns filtered statistics',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM alarms'))return result([{total:2,resolved:1,open:1}]);
      if(sql.includes('FROM incidents'))return result([{total:1,completed:1}]);
      if(sql.includes('FROM patrol_scans'))return result([{total:3,deviations:1}]);
      if(sql.includes('FROM work_time_entries'))return result([{minutes:480,entries:1}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/statistics?from=2026-11-01&to=2026-11-30').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);expect(response.body.alarms.open).toBe(1);
    const qualificationCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employee_qualifications q'));
    expect(qualificationCall?.[0]).toContain("(now() AT TIME ZONE 'Europe/Berlin')::date");
    expect(qualificationCall?.[0]).toContain('c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code)');
    expect(qualificationCall?.[0]).toContain("d.document_status='active'");
    expect(qualificationCall?.[0]).toContain('dv.lifecycle_state=\'available\'');
    expect(qualificationCall?.[0]).toContain('evidence_problems');
  });

  it('exports a tenant-scoped employee report',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM employees'))return result([{id:'employee-1',name:'Worker'}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/employees?format=csv').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);expect(response.text).toContain('employee-1');
  });

  it('rejects malformed report filter UUIDs with 400',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/patrols?site_id=not-a-uuid').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(400);expect(response.body.error).toBe('Ungültiger Berichtsfilter');
  });

  it('emits a PDF with a resolvable cross-reference table',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM alarms'))return result([{id:'alarm-1',status:'open',description:'Test (alarm)'}]);
      return result([]);
    });
    const response=await request(app)
      .get('/api/v1/reports/alarms?format=pdf')
      .set('Cookie',csrf.Cookie)
      .buffer(true)
      .parse((res,callback)=>{
        const chunks:Buffer[]=[];
        res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
        res.on('end',()=>callback(null,Buffer.concat(chunks).toString('utf8')));
      });
    expect(response.status).toBe(200);
    const pdf=String(response.body);
    const xrefOffset=Number(pdf.match(/startxref\s+(\d+)/)?.[1]);
    expect(xrefOffset).toBeGreaterThan(0);
    expect(pdf.slice(xrefOffset,xrefOffset+4)).toBe('xref');
    expect(pdf).toContain('0000000009 00000 n');
  });
});

describe('phase 5 TimeScan and privacy',()=>{
  it('reports provider status without treating unconfigured providers as verified',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/admin/provider-status').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({provider:'smtp',status:'not_configured'}),
      expect.objectContaining({provider:'sms',status:'not_configured'}),
      expect.objectContaining({provider:'timescan',status:'not_configured'}),
    ]));
    expect(response.body.providers.some((provider:{status:string})=>provider.status==='verified')).toBe(false);
  });

  it('syncs work time idempotently through the adapter',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM timescan_connections'))return result([{id:'connection-1',base_url:'https://timescan.test',account_ref:'acct',secret_ref:'TIMESCAN_TEST_SECRET',enabled:true}]);
      if(sql.includes('INSERT INTO timescan_sync_runs'))return result([{id:'run-1'}]);
      if(sql.includes('FROM employees'))return result([{id:'employee-1'}]);
      if(sql.includes('INSERT INTO work_time_entries'))return result([{id:'entry-1'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/timescan/sync?from=2026-11-01&to=2026-11-30').set(csrf);
    expect(response.status).toBe(200);expect(response.body.imported_count).toBe(1);expect(listWorkTimes).toHaveBeenCalled();
  });

  it('exports a data subject record with permission protection',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT id,email,role'))return result([{id:user.id,email:user.email,role:user.role}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/privacy/export').set(csrf).send({user_id:user.id});
    expect(response.status).toBe(200);expect(response.body.user.email).toBe(user.email);
  });

  it('requires an audit reason for backup settings changes',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      return result([]);
    });
    const response=await request(app).put('/api/v1/settings/backups').set(csrf).send({enabled:true,schedule_kind:'daily',schedule_time:'02:00',schedule_timezone:'UTC'});
    expect(response.status).toBe(400);
  });

  it('does not expose provider secret storage',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM provider_settings'))return result([{provider:'smtp',config:{host:'smtp.example'},secret_ref:'SMTP_SECRET',encrypted_secret:'PLAINTEXT-MUST-NOT-LEAK',enabled:true}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/settings/providers').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('PLAINTEXT-MUST-NOT-LEAK');
    expect(response.body.providers[0].secret_ref).toBe('SMTP_SECRET');
  });

  it('rejects unencrypted FTP target types',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/backups/targets').set(csrf).send({name:'legacy',target_kind:'ftp',config:{host:'example'},secret_ref:'FTP_SECRET',reason:'Remove insecure target'});
    expect(response.status).toBe(400);
  });
});
