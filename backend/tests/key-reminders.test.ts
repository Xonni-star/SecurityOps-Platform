import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const notificationMock=jest.fn();
const auditMock=jest.fn();
const acquireMock=jest.fn<(name:string,ttl:number)=>Promise<boolean>>();
const releaseMock=jest.fn<()=>Promise<void>>();

jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTenantContext:async (_tenantId:string,work:()=>Promise<unknown>)=>work(),
}));
jest.unstable_mockModule('../src/config/env.js',()=>({
  env:{KEY_QR_SECRET:'test-key-qr-secret',KEY_REMINDER_DAYS:[3,0]},
}));
jest.unstable_mockModule('../src/services/notifications.js',()=>({
  queueNotificationEvent:notificationMock,
}));
jest.unstable_mockModule('../src/services/audit.js',()=>({
  recordAudit:auditMock,
}));
jest.unstable_mockModule('../src/services/worker-lease.js',()=>({
  tryAcquireWorkerLease:acquireMock,
  releaseWorkerLease:releaseMock,
}));

const {processKeyReminders,startKeyReminderWorker,stopKeyReminderWorker}=await import('../src/services/key-reminders.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const keyId='00000000-0000-4000-8000-000000000030';
const now=new Date('2026-11-26T12:00:00.000Z');
const dueRows=[
  {tenant_id:tenant,id:keyId,key_code:'K-1001',label:'Haupteingang',due_at:'2026-11-29T12:00:00.000Z',holder_name:'Mia Guard'},
  {tenant_id:tenant,id:'00000000-0000-4000-8000-000000000031',key_code:'K-1002',label:'Nebenpforte',due_at:'2026-11-26T12:00:00.000Z',holder_name:null},
  {tenant_id:tenant,id:'00000000-0000-4000-8000-000000000032',key_code:'K-1003',label:'Depot',due_at:'2026-11-25T12:00:00.000Z',holder_name:'Leo Wache'},
  {tenant_id:tenant,id:'00000000-0000-4000-8000-000000000033',key_code:'K-1004',label:'Tresor',due_at:'2026-12-03T12:00:00.000Z',holder_name:null},
];

function install(claimed:Set<string>){
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
    const text=String(sql);
    if(text.includes('FROM keys k'))return result(dueRows);
    if(text.includes('INSERT INTO key_reminder_state')){
      const stateKey=`${values[1]}:${values[3]}`;
      if(claimed.has(stateKey))return result([],0);
      claimed.add(stateKey);
      return result([{key_id:values[1]}],1);
    }
    return result([]);
  });
}

beforeEach(()=>{
  notificationMock.mockReset();
  auditMock.mockReset();
  acquireMock.mockReset();
  releaseMock.mockReset();
  acquireMock.mockResolvedValue(true);
  releaseMock.mockResolvedValue(undefined);
});

describe('key return reminders',()=>{
  it('queues configured day offsets plus overdue reminders once and skips unconfigured dates',async()=>{
    const claimed=new Set<string>();
    install(claimed);
    const summary=await processKeyReminders(now);
    expect(summary).toEqual({queued:3});
    expect(notificationMock).toHaveBeenCalledTimes(3);
    expect(notificationMock.mock.calls.map(call=>call[2])).toEqual([
      'keys-return-due:00000000-0000-4000-8000-000000000030:3:2026-11-29T12:00:00.000Z',
      'keys-return-due:00000000-0000-4000-8000-000000000031:0:2026-11-26T12:00:00.000Z',
      'keys-return-due:00000000-0000-4000-8000-000000000032:-1:2026-11-25T12:00:00.000Z',
    ]);
    expect(auditMock).toHaveBeenCalledWith(tenant,null,'keys.reminder.queued','key',keyId,
      expect.objectContaining({days:3,due_at:'2026-11-29T12:00:00.000Z'}));
  });

  it('does not re-queue a claimed reminder on a rerun',async()=>{
    const claimed=new Set<string>();
    install(claimed);
    await processKeyReminders(now);
    notificationMock.mockClear();
    auditMock.mockClear();
    expect(await processKeyReminders(now)).toEqual({queued:0});
    expect(notificationMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('uses the worker lease and honors the configured interval',()=>{
    const cleared=jest.spyOn(global,'clearInterval').mockImplementation(()=>undefined);
    const stopped=jest.spyOn(global,'setInterval').mockImplementation(()=>({unref:()=>undefined}) as unknown as NodeJS.Timeout);
    try{
      const stop=startKeyReminderWorker(120000);
      expect(stopped).toHaveBeenCalledWith(expect.any(Function),120000);
      stop();
      expect(cleared).toHaveBeenCalled();
    }finally{
      stopped.mockRestore();
      cleared.mockRestore();
      stopKeyReminderWorker();
    }
  });
});
