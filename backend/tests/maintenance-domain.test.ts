import {describe,expect,it} from '@jest/globals';
import {effectiveMaintenanceStatus,maintenanceIsOverdue,nextMaintenanceDate} from '../src/services/maintenance-domain.js';

const now = new Date('2026-01-10T12:00:00Z');

describe('maintenance workflow rules',()=>{
  it('derives overdue only from unfinished orders with a past due date',()=>{
    expect(effectiveMaintenanceStatus({status:'planned',due_on:'2026-01-09'},now)).toBe('overdue');
    expect(effectiveMaintenanceStatus({status:'in_progress',due_on:'2026-01-09'},now)).toBe('overdue');
    expect(effectiveMaintenanceStatus({status:'planned',due_on:'2026-01-10'},now)).toBe('planned');
    expect(effectiveMaintenanceStatus({status:'open',due_on:'2026-02-01'},now)).toBe('open');
    expect(effectiveMaintenanceStatus({status:'planned',due_on:null},now)).toBe('planned');
    expect(effectiveMaintenanceStatus({status:'completed',due_on:'2026-01-01'},now)).toBe('completed');
    expect(effectiveMaintenanceStatus({status:'cancelled',due_on:'2026-01-01'},now)).toBe('cancelled');
    expect(maintenanceIsOverdue({status:'completed',due_on:'2026-01-01'},now)).toBe(false);
  });

  it('computes the next maintenance date from the completion date and interval',()=>{
    expect(nextMaintenanceDate('2026-01-10',30)).toBe('2026-02-09');
    expect(nextMaintenanceDate('2026-01-10',90)).toBe('2026-04-10');
    expect(nextMaintenanceDate('2026-01-10',null)).toBeNull();
    expect(nextMaintenanceDate('2026-01-10',0)).toBeNull();
  });
});
