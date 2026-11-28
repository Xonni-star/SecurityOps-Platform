import {describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {
  customerReportCsvLines,customerReportDayRange,customerReportFilterResponse,
  customerReportFingerprint,customerReportTextLines,isCustomerReportKind,
}=await import('../src/services/customer-report-domain.js');

const row={
  id:'row-1',occurred_at:'2026-11-05T10:00:00.000Z',site_id:'site-1',site_name:'Nordgebäude',
  category:'Einsatz',label:'Tor 1',status:'Abgeschlossen',metric:1,
};

describe('customer-report-domain',()=>{
  it('bildet Kalendertagsgrenzen in Europe/Berlin auch über die Sommerzeitumstellung',()=>{
    const winter=customerReportDayRange({from:'2026-01-15',to:'2026-01-15'});
    expect(winter.from.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(winter.to.toISOString()).toBe('2026-01-15T22:59:59.000Z');

    const summer=customerReportDayRange({from:'2026-07-15',to:'2026-07-15'});
    expect(summer.from.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(summer.to.toISOString()).toBe('2026-07-15T21:59:59.000Z');
  });

  it('kennt genau die vier zulässigen Nachweisarten',()=>{
    for(const kind of ['control-walks','watchbook','alarms','incidents'])expect(isCustomerReportKind(kind)).toBe(true);
    expect(isCustomerReportKind('dms')).toBe(false);
  });

  it('liefert Filter durchgehend in snake_case mit Berliner Zeitzone',()=>{
    const filter=customerReportFilterResponse(
      {from:'2026-11-01',to:'2026-11-28',q:'Tor',sort:'label',order:'asc'},
      {fromDay:'2026-11-01',toDay:'2026-11-28'},2,25,51,
    );
    expect(filter).toEqual(expect.objectContaining({
      page:2,page_size:25,page_count:3,total:51,sort:'label',order:'asc',
      timezone:'Europe/Berlin',
    }));
    expect(filter).not.toHaveProperty('pageSize');
  });

  it('bildet einen deterministischen Fingerprint aus Filtern und freigegebener Datenbasis',()=>{
    const filters={from:'2026-11-01',to:'2026-11-28',site_id:'site-1'};
    const first=customerReportFingerprint('incidents',filters,[row]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(customerReportFingerprint('incidents',filters,[row])).toBe(first);
    expect(customerReportFingerprint('incidents',filters,[{...row,status:'Offen'}])).not.toBe(first);
  });

  it('exportiert Deutsch mit Semikolon und ohne vertrauliche Felder',()=>{
    const csv=customerReportCsvLines([row]);
    expect(csv[0]).toBe('"Referenz";"Zeitpunkt (Europe/Berlin)";"Objekt";"Kategorie";"Bezeichnung";"Status";"Kennzahl"');
    expect(csv[1]).toContain('05.11.2026');
    expect(csv.join('\n')).not.toContain('author_email');
    const text=customerReportTextLines('Nachweisbericht','incidents',{from:'2026-11-01',to:'2026-11-28'},[row]);
    expect(text.join('\n')).toContain('keine Zertifizierungs- oder Rechtsaussage');
    expect(text.join('\n')).not.toContain('description');
  });
});
