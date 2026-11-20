import {describe,expect,it} from '@jest/globals';
import {decryptSecretPayload,encryptSecretPayload,isScheduleDue,retentionDue,scheduleIsValid,selectRetentionRuns} from '../src/services/backup-domain.js';

describe('backup scheduling and retention',()=>{
  it('accepts daily and weekly schedules and only fires at the configured minute',()=>{
    expect(scheduleIsValid({enabled:true,kind:'daily',time:'02:05',timezone:'UTC'})).toBe(true);
    expect(isScheduleDue({enabled:true,kind:'daily',time:'02:05',timezone:'UTC'},new Date('2026-11-20T02:05:00Z'))).toBe(true);
    expect(isScheduleDue({enabled:true,kind:'daily',time:'02:05',timezone:'UTC'},new Date('2026-11-20T02:06:00Z'))).toBe(false);
    expect(isScheduleDue({enabled:true,kind:'weekly',time:'02:05',weekday:5,timezone:'UTC'},new Date('2026-11-20T02:05:00Z'))).toBe(true);
  });
  it('deletes only runs outside count and age retention rules',()=>{
    expect(retentionDue('2026-01-01T00:00:00Z',30,new Date('2026-02-01T00:00:00Z'))).toBe(true);
    const runs=[{started_at:'2026-01-01T00:00:00Z'},{started_at:'2026-01-02T00:00:00Z'},{started_at:'2026-01-03T00:00:00Z'}];
    expect(selectRetentionRuns(runs,2,null,new Date('2026-02-01T00:00:00Z'))).toEqual([runs[0]]);
  });
  it('never stores a secret payload in plaintext',()=>{
    const encrypted=encryptSecretPayload({username:'user',password:'secret'},'test-key');
    expect(encrypted).not.toContain('secret');
    expect(decryptSecretPayload(encrypted,'test-key')).toEqual({username:'user',password:'secret'});
  });
});
