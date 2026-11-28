import {describe,expect,it} from '@jest/globals';
import {parseReportingFilters,reportCsv,reportingDayRange,safeReportFilename} from '../src/services/reporting-domain.js';
import {pdfReportLines} from '../src/services/pdf.js';
import {xlsxWorkbook} from '../src/services/xlsx.js';

describe('reporting services',()=>{
  it('uses Berlin calendar bounds including daylight saving time',()=>{
    const winter=reportingDayRange({from:'2026-01-15',to:'2026-01-15'});
    expect(winter.from.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(winter.to.toISOString()).toBe('2026-01-15T22:59:59.999Z');
    const summer=reportingDayRange({from:'2026-07-15',to:'2026-07-15'});
    expect(summer.from.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(summer.to.toISOString()).toBe('2026-07-15T21:59:59.999Z');
    expect(()=>reportingDayRange({from:'2026-02-30'})).toThrow('Ungültiger Zeitraum');
  });

  it('normalizes filters and file names',()=>{
    const filters=parseReportingFilters({from:'2026-11-01',to:'2026-11-30',q:'  Prüfung  ',page:'3',page_size:'50',sort:'status',order:'asc'});
    expect(filters).toMatchObject({from:'2026-11-01',to:'2026-11-30',search:'Prüfung',page:3,pageSize:50,sort:'status',order:'asc'});
    expect(safeReportFilename('documents/../',filters,'xlsx')).toBe('reporting-documents-2026-11-01-bis-2026-11-30.xlsx');
    expect(()=>parseReportingFilters({page_size:'501'})).toThrow('Ungültiger Filter page_size');
  });

  it('writes an escaped semicolon CSV with BOM',()=>{
    const csv=reportCsv([{
      id:'1',label:'Test "A"; B',status:'ok',occurred_at:'2026-11-01T10:00:00Z',
      site_id:null,customer_id:null,employee_id:null,site_name:null,customer_name:null,employee_name:null,
      details:{Hinweis:'Zeile\nZwei'},metric:2,metric_label:'KiB',
    }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Test ""A""; B"');
    expect(csv).not.toContain('\nZeile');
  });

  it('escapes PDF text and emits a valid xref offset',()=>{
    const buffer=pdfReportLines(['Bericht (Prüfung) \\ Sonderfall','Zweite Zeile']);
    const pdf=buffer.toString('utf8');
    const offset=Number(pdf.match(/startxref\s+(\d+)/)?.[1]);
    expect(buffer.subarray(offset,offset+4).toString()).toBe('xref');
    expect(pdf).toContain('Bericht \\(Prüfung\\) \\\\ Sonderfall');
    expect(pdf).toContain('0 -13 Td (Zweite Zeile) Tj');
  });

  it('builds a ZIP-based XLSX workbook with well-formed XML parts',()=>{
    const buffer=xlsxWorkbook([['Zeitpunkt','Bezeichnung'],['2026-11-01','Prüfung & <Test>']]);
    expect(buffer.subarray(0,2).toString()).toBe('PK');
    const xml=buffer.toString('utf8');
    expect(xml).toContain('Prüfung &amp; &lt;Test&gt;');
    expect(xml).toContain('<dimension ref="A1:B2"/>');
  });
});
