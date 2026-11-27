import {describe,expect,it} from '@jest/globals';
import {classifyDocument,expiryBucket,type ClassifiableDocument} from '../src/services/dms-document-status.js';

const available=():ClassifiableDocument=>({
  document_status:'active',
  approval_status:'approved',
  valid_from:'2026-01-01',
  valid_until:'2027-01-01',
  versions:[{lifecycle_state:'available'}],
});

describe('DMS document status: Berliner Kalendertage und Prüfstatus',()=>{
  it('verwendet an DST-Grenzen den Berliner Tag statt des UTC-Tags',()=>{
    const spring=new Date('2026-03-29T22:30:00Z'); // Berlin: 2026-03-30
    expect(expiryBucket('2026-03-29',spring)).toEqual({bucket:'expired',days:-1});
    expect(expiryBucket('2026-03-30',spring)).toEqual({bucket:'within_7_days',days:0});
    expect(expiryBucket('2026-04-06',spring)).toEqual({bucket:'within_7_days',days:7});

    const autumn=new Date('2026-10-25T23:30:00Z'); // Berlin: 2026-10-26
    expect(expiryBucket('2026-10-25',autumn)).toEqual({bucket:'expired',days:-1});
    expect(expiryBucket('2026-10-26',autumn)).toEqual({bucket:'within_7_days',days:0});
  });

  it('behandelt bald prüfpflichtige Nachweise nicht als uneingeschränkt gültig',()=>{
    const result=classifyDocument({...available(),review_on:'2026-04-01'},new Date('2026-03-15T12:00:00Z'));
    expect(result.computed_status).toBe('bald_pruefpflichtig');
    expect(result.review_state).toBe('due_soon');
    expect(result.is_currently_valid).toBe(false);
  });

  it('lässt gültige und bald ablaufende Nachweise weiterhin als gültig durch',()=>{
    expect(classifyDocument(available(),new Date('2026-03-15T12:00:00Z')).is_currently_valid).toBe(true);
    const expiring=classifyDocument({...available(),valid_until:'2026-03-20'},new Date('2026-03-15T12:00:00Z'));
    expect(expiring.computed_status).toBe('lauf_bald_ab');
    expect(expiring.is_currently_valid).toBe(true);
  });
});
