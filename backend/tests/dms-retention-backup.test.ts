import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const {configureDmsAdapters}=await import('../src/routes/dms.js');
const tenant='00000000-0000-4000-8000-00000000000a';
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const admin={
  id:'00000000-0000-4000-8000-000000000002',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['dms:read','dms:write','dms:delete','dms:backup:read'],permission_grants:[],site_ids:[],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const viewer={...admin,permissions:['dms:read'],role:'viewer',id:'00000000-0000-4000-8000-000000000003'};
let activeUser:Record<string,unknown>;
let backupRow:Record<string,unknown>|null;
let versionRows:Record<string,unknown>[];
const deletedKeys:string[]=[];

beforeEach(()=>{
  activeUser=admin;
  backupRow={provider:'minio',contract_version:'dms-blob-backup-v1',status:'healthy',last_backup_at:'2026-01-01T00:00:00Z',last_restore_test_at:'2026-01-02T00:00:00Z',details:{}};
  versionRows=[];
  deletedKeys.length=0;
  configureDmsAdapters({
    put:async()=>undefined,
    get:async()=>({content:Buffer.from('x')}),
    delete:async(key:string)=>{deletedKeys.push(key);},
    ready:async()=>undefined,
  },{scan:async()=>({clean:true}),ready:async()=>undefined});
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    const text=String(sql);
    if(text.includes('FROM sessions'))return result([activeUser]);
    if(text.includes('FROM dms_versions WHERE tenant_id'))return result(versionRows);
    if(text.includes('FROM dms_blob_backup_status'))return result(backupRow?[backupRow]:[]);
    if(text.includes('INSERT INTO audit_events'))return result([],1);
    return result([]);
  });
});

describe('DMS-Aufbewahrung und Backup-Status',()=>{
  it('löscht nur fällige verfügbare Versionen und protokolliert die Anwendung',async()=>{
    versionRows=[
      {id:'00000000-0000-4000-8000-0000000000c1',object_key:'dms/due',retention_until:'2020-01-01T00:00:00Z'},
    ];
    const response=await request(app).post('/api/v1/dms/retention/apply').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({deleted:1});
    expect(deletedKeys).toEqual(['dms/due']);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE dms_versions SET lifecycle_state'));
    expect(String(update?.[0])).toContain("lifecycle_state='deleted'");
    expect(update?.[1]).toEqual([tenant,versionRows[0].id]);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('dms.retention.applied');
    expect(audit?.[1]?.[5]).toEqual({deleted:1});
  });

  it('lässt nicht fällige Versionen unangetastet',async()=>{
    versionRows=[
      {id:'00000000-0000-4000-8000-0000000000c2',object_key:'dms/keep',retention_until:'2099-01-01T00:00:00Z'},
    ];
    const response=await request(app).post('/api/v1/dms/retention/apply').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({deleted:0});
    expect(deletedKeys).toEqual([]);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE dms_versions'))).toBe(false);
  });

  it('meldet den mandantenspezifischen Backup-Vertrag ohne Datenbankbackup-Versprechen',async()=>{
    const response=await request(app).get('/api/v1/dms/backup/status').set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      provider:'minio',contract_version:'dms-blob-backup-v1',status:'healthy',database_backup_independent:true,
    }));
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_blob_backup_status'));
    expect(call?.[1]).toEqual([tenant]);
  });

  it('liefert den konfigurierten Vertrag auch ohne hinterlegten Status',async()=>{
    backupRow=null;
    const response=await request(app).get('/api/v1/dms/backup/status').set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({contractVersion:'dms-blob-backup-v1',databaseBackupIndependent:true}));
  });

  it('verweigert Aufbewahrungslauf und Backup-Status ohne die passenden Rechte',async()=>{
    activeUser=viewer;
    const retention=await request(app).post('/api/v1/dms/retention/apply').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(retention.status).toBe(403);
    const backup=await request(app).get('/api/v1/dms/backup/status').set('Cookie',csrf);
    expect(backup.status).toBe(403);
    expect(deletedKeys).toEqual([]);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM dms_versions WHERE tenant_id'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM dms_blob_backup_status'))).toBe(false);
  });
});
