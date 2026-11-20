import {describe,expect,it,jest,beforeEach} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTenantContext:async (_tenant:string,work:()=>Promise<unknown>)=>work()}));
jest.unstable_mockModule('../src/services/realtime.js',()=>({publish:jest.fn()}));
const {queueNotificationEvent}=await import('../src/services/notifications.js');

describe('backup notification delivery contract',()=>{
  beforeEach(()=>queryMock.mockReset());
  it('uses a deduplicated event key and never puts provider secrets in notification content',async()=>{
    queryMock.mockResolvedValue({rows:[],rowCount:0});
    await queueNotificationEvent('tenant-1','backup.failed','backup:run-1','Backup fehlgeschlagen','Backup-Lauf run-1 ist fehlgeschlagen. Prüfen Sie den Backup-Status.','backup_run','run-1');
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('notification_deliveries'))?.[0] as string;
    expect(insert).toContain('ON CONFLICT(event_key,channel,recipient) DO NOTHING');
    expect(JSON.stringify(queryMock.mock.calls)).not.toContain('secret');
  });
});
