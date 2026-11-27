import type {QueryResult} from 'pg';
import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const withTenantContextMock=jest.fn(async(_tenantId:string,work:()=>Promise<unknown>)=>work());
const queueNotificationEventMock=jest.fn(async(..._args:unknown[])=>{});
const recordAuditMock=jest.fn(async(..._args:unknown[])=>{});
const tryAcquireWorkerLeaseMock=jest.fn(async(..._args:unknown[])=>true);
const releaseWorkerLeaseMock=jest.fn(async(..._args:unknown[])=>{});

jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:withTenantContextMock,
}));
jest.unstable_mockModule('../src/services/notifications.js',()=>({queueNotificationEvent:queueNotificationEventMock}));
jest.unstable_mockModule('../src/services/audit.js',()=>({recordAudit:recordAuditMock}));
jest.unstable_mockModule('../src/services/worker-lease.js',()=>({
  tryAcquireWorkerLease:tryAcquireWorkerLeaseMock,
  releaseWorkerLease:releaseWorkerLeaseMock,
}));

const {
  processQualificationReminders,
  startQualificationReminderWorker,
  stopQualificationReminderWorker,
}=await import('../src/services/qualification-reminders.js');

const tenant='00000000-0000-4000-8000-00000000000a';
const otherTenant='00000000-0000-4000-8000-00000000000b';
const employee='00000000-0000-4000-8000-000000000001';
const qualification='00000000-0000-4000-8000-000000000002';
const catalog='00000000-0000-4000-8000-000000000003';
const now=new Date('2026-03-01T23:30:00Z');
const today='2026-03-02';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

type Handler={match:(sql:string)=>boolean;rows:(sql:string,params:unknown[])=>unknown[]};
let handlers:Handler[]=[];
let tenantRows:unknown[]=[];
const seenKeys=new Set<string>();

function on(match:string,rows:unknown[]|((sql:string,params:unknown[])=>unknown[])){
  handlers.push({match:(sql)=>sql.includes(match),rows:typeof rows==='function'?rows:()=>rows});
}

function expiringRow(days:number,id=qualification){
  return {
    tenant_id:tenant,qualification_id:id,employee_id:employee,employee_name:'Mia Guard',
    catalog_id:catalog,code:'sachkunde_34a',name:'Sachkunde nach §34a',valid_until:today,
    days_left:days,
  };
}

beforeEach(()=>{
  handlers=[];
  tenantRows=[{id:tenant}];
  seenKeys.clear();
  queryMock.mockReset();
  withTenantContextMock.mockClear();
  queueNotificationEventMock.mockClear();
  recordAuditMock.mockClear();
  tryAcquireWorkerLeaseMock.mockClear();
  releaseWorkerLeaseMock.mockClear();
  tryAcquireWorkerLeaseMock.mockResolvedValue(true);
  on('SELECT id FROM tenants',()=>tenantRows);
  on('INSERT INTO qualification_reminder_state',(_sql,params)=>{
    const key=String(params[1]);
    if(seenKeys.has(key))return [];
    seenKeys.add(key);
    return [{event_key:key}];
  });
  queryMock.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    const handler=handlers.find(candidate=>candidate.match(String(sql)));
    return result(handler?handler.rows(String(sql),values):[]);
  });
});

afterEach(()=>stopQualificationReminderWorker());

function queuedEvents(){
  return queueNotificationEventMock.mock.calls.map(call=>({
    tenant:String(call[0]),eventType:String(call[1]),eventKey:String(call[2]),
    title:String(call[3]),body:String(call[4]),entityType:String(call[5]),entityId:String(call[6]),subject:String(call[7]),
  }));
}

describe('qualification reminders: Qualifikationserinnerungen',()=>{
  it('ruft für jeden Tenant genau einmal withTenantContext auf und bleibt tenant-scoped',async()=>{
    tenantRows=[{id:tenant},{id:otherTenant}];
    const outcome=await processQualificationReminders(now);
    expect(outcome).toEqual({queued:0});
    expect(withTenantContextMock.mock.calls.map(call=>call[0])).toEqual([tenant,otherTenant]);
    const scoped=queryMock.mock.calls.filter(([sql])=>String(sql).includes('FROM employee_qualifications q'));
    expect(scoped).toHaveLength(6); // drei Abfragen pro Tenant (die dritte enthält die qualification-Subquery)
    const tenantOf=(call:unknown[])=>{
      const values=(call[1] as unknown[])??[];
      return values[values.length-1];
    };
    expect(scoped.slice(0,3).map(tenantOf)).toEqual([tenant,tenant,tenant]);
    expect(scoped.slice(3).map(tenantOf)).toEqual([otherTenant,otherTenant,otherTenant]);
  });

  it('erzeugt expiring-Ereignisse nur an den konfigurierten Tagen mit deterministischem, tenant-präfixiertem Key',async()=>{
    // Die Datenbank liefert aufgrund von =ANY(s.reminder_days) nur die konfigurierten Tage (90 und 7).
    on('=ANY(s.reminder_days)',[expiringRow(90),expiringRow(7)]);
    const outcome=await processQualificationReminders(now);
    expect(outcome.queued).toBe(2);
    const events=queuedEvents();
    expect(events.map(event=>event.eventKey)).toEqual([
      `qualification.expiring:${tenant}:${qualification}:90:${today}`,
      `qualification.expiring:${tenant}:${qualification}:7:${today}`,
    ]);
    expect(events[0]).toMatchObject({
      tenant,eventType:'qualification.expiring',title:'Qualifikation läuft ab',
      entityType:'employee_qualification',entityId:qualification,subject:'Qualifikation läuft ab',
    });
    expect(events[0].body).toContain('Sachkunde nach §34a');
    expect(events[0].body).toContain('Mia Guard');
    expect(events[0].body).toContain('in 90 Tagen');
    expect(events.map(event=>event.eventKey).some(key=>key.includes(':89:'))).toBe(false);
  });

  it('verhindert doppelte Ereignisse beim zweiten Lauf über INSERT ... ON CONFLICT',async()=>{
    on('=ANY(s.reminder_days)',[expiringRow(90)]);
    const first=await processQualificationReminders(now);
    expect(first.queued).toBe(1);
    expect(queuedEvents()).toHaveLength(1);
    const second=await processQualificationReminders(now);
    expect(second.queued).toBe(0);
    expect(queuedEvents()).toHaveLength(1);
    const claims=queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO qualification_reminder_state'));
    expect(claims).toHaveLength(2);
    expect(String(claims[0][0])).toContain('ON CONFLICT(tenant_id,event_key) DO NOTHING');
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
  });

  it('erzeugt qualification.expired für abgelaufene Pflichtqualifikationen',async()=>{
    on("q.status IN ('expired','revoked','invalid')",[{
      tenant_id:tenant,qualification_id:qualification,employee_id:employee,employee_name:'Mia Guard',
      catalog_id:catalog,code:'sachkunde_34a',name:'Sachkunde nach §34a',valid_until:'2026-02-01',days_left:0,
    }]);
    expect((await processQualificationReminders(now)).queued).toBe(1);
    expect(queuedEvents()[0]).toMatchObject({
      tenant,eventType:'qualification.expired',
      eventKey:`qualification.expired:${tenant}:${qualification}:${today}`,
      entityType:'employee_qualification',entityId:qualification,
    });
    expect(queuedEvents()[0].body).toContain('Pflichtqualifikation');
  });

  it('erzeugt qualification.missing_required mit Katalog als Entität',async()=>{
    on("e.employment_status IN ('active','probation')",[{
      tenant_id:tenant,qualification_id:null,employee_id:employee,employee_name:'Mia Guard',
      catalog_id:catalog,code:'erste_hilfe',name:'Erste Hilfe',valid_until:null,days_left:0,
    }]);
    expect((await processQualificationReminders(now)).queued).toBe(1);
    expect(queuedEvents()[0]).toMatchObject({
      tenant,eventType:'qualification.missing_required',
      eventKey:`qualification.missing_required:${tenant}:${employee}:${catalog}:${today}`,
      entityType:'qualification_catalog',entityId:catalog,
    });
    expect(queuedEvents()[0].body).toContain('fehlt die Pflichtqualifikation Erste Hilfe');
  });

  it('legt Empfänger-Subscriptionen an und auditiert das Ereignis mit dem festen Zeitpunkt',async()=>{
    on('=ANY(s.reminder_days)',[expiringRow(30)]);
    expect((await processQualificationReminders(now)).queued).toBe(1);
    const subscriptions=queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO notification_subscriptions'));
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0][1]).toEqual([tenant,'qualification.expiring',employee]);
    expect(subscriptions[1][1]).toEqual([tenant,'qualification.expiring',employee,today]);
    const audit=recordAuditMock.mock.calls[0]!;
    expect(audit.slice(0,5)).toEqual([tenant,null,'qualification.expiring','employee_qualification',qualification]);
    expect(audit[5]).toMatchObject({
      event_key:`qualification.expiring:${tenant}:${qualification}:30:${today}`,
      due_date:today,days_left:30,run_at:now.toISOString(),
    });
  });

  it('verwendet einen Worker-Lease und gibt ihn nach dem Lauf frei',async()=>{
    let stop:()=>void=stopQualificationReminderWorker;
    try{
      stop=startQualificationReminderWorker(20);
      await new Promise(resolve=>setTimeout(resolve,80));
      stop();
      expect(tryAcquireWorkerLeaseMock).toHaveBeenCalledWith('qualification-reminders-worker',60000);
      expect(queryMock.mock.calls.some(([sql])=>String(sql)==='SELECT id FROM tenants')).toBe(true);
      expect(releaseWorkerLeaseMock).toHaveBeenCalledWith('qualification-reminders-worker');
    }finally{stop();}
  });

  it('startet keine Verarbeitung, wenn der Worker-Lease nicht erworben wurde',async()=>{
    tryAcquireWorkerLeaseMock.mockResolvedValue(false);
    let stop:()=>void=stopQualificationReminderWorker;
    try{
      stop=startQualificationReminderWorker(20);
      await new Promise(resolve=>setTimeout(resolve,80));
      stop();
      expect(queryMock.mock.calls.some(([sql])=>String(sql)==='SELECT id FROM tenants')).toBe(false);
      expect(releaseWorkerLeaseMock).not.toHaveBeenCalled();
    }finally{stop();}
  });
});
