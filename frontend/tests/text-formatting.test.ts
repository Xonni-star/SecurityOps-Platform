import {describe,expect,it} from 'vitest';
import {
  berlinDateToIso,berlinDateTimeToIso,berlinToday,formatCurrency,formatDate,formatDateTime,formatNumber,formatTime,isoToBerlinDateTimeLocal,
} from '../src/lib/format';
import {priorityLabel,roleLabel,riskLabel,statusLabel} from '../src/lib/status';
import {auditEventLabel,commonText,historyDetailText,requiredUuidMessage} from '../src/lib/text';

describe('deutsche Formatierung',()=>{
  it('formatiert Datums- und Zeitangaben in de-DE und Europe/Berlin',()=>{
    expect(formatDate('2026-01-02T23:30:00Z')).toBe('03.01.2026');
    expect(formatDateTime('2026-01-02T23:30:00Z')).toBe('03.01.2026, 00:30');
    expect(formatTime('2026-01-02T23:30:00Z')).toBe('00:30');
    expect(formatDate(null)).toBe('–');
  });

  it('verwendet Komma als Dezimal- und Punkt als Tausendertrennzeichen',()=>{
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatCurrency(1234.5)).toContain('1.234,50');
    expect(formatNumber(Number.NaN)).toBe('–');
  });

  it('rechnet lokale Eingaben mit der Berliner Zeitzone in UTC um',()=>{
    expect(berlinDateToIso('2026-01-02')).toBe('2026-01-01T23:00:00.000Z');
    expect(berlinDateToIso('2026-07-01')).toBe('2026-06-30T22:00:00.000Z');
    expect(berlinDateTimeToIso('2026-07-01T12:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(isoToBerlinDateTimeLocal('2026-07-01T10:00:00Z')).toBe('2026-07-01T12:00');
    expect(berlinToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('einheitliche deutsche Begriffe',()=>{
  it('übersetzt technische Statuswerte kontextabhängig',()=>{
    expect(statusLabel('active')).toBe('Aktiv');
    expect(statusLabel('pending')).toBe('Ausstehend');
    expect(statusLabel(null)).toBe('Nicht zugewiesen');
    expect(statusLabel('resolved','alarm')).toBe('Erledigt');
    expect(statusLabel('planning','site')).toBe('In Planung');
    expect(statusLabel('issued','key')).toBe('Ausgegeben');
    expect(statusLabel('reported_lost','movement')).toBe('Verlust gemeldet');
    expect(statusLabel('item_added','movement')).toBe('Schlüssel hinzugefügt');
    expect(statusLabel('partial_return','movement')).toBe('Teilweise zurückgegeben');
    expect(statusLabel('scanning','document')).toBe('In Prüfung');
    expect(statusLabel('in_progress','general')).toBe('In Bearbeitung');
    expect(statusLabel('battery','sensor')).toBe('Batteriestand');
    expect(statusLabel('completed','task')).toBe('Erledigt');
    expect(statusLabel('cancelled','task')).toBe('Abgebrochen');
  });

  it('stellt Rollen, Prioritäten und Risiken deutsch dar',()=>{
    expect(roleLabel('admin')).toBe('Administrator');
    expect(priorityLabel('critical')).toBe('Kritisch');
    expect(riskLabel('unknown')).toBe('Nicht bewertet');
  });

  it('stellt zentrale Beschriftungen und Meldungen bereit',()=>{
    expect(commonText.exportCsv).toBe('CSV exportieren');
    expect(commonText.download).toBe('Herunterladen');
    expect(requiredUuidMessage('Benutzerkennung')).toBe('Bitte eine gültige Benutzerkennung angeben.');
    expect(requiredUuidMessage('Mitarbeiter','maskulin')).toBe('Bitte einen gültigen Mitarbeiter angeben.');
    expect(requiredUuidMessage('Objekt','neutral')).toBe('Bitte ein gültiges Objekt angeben.');
  });

  it('stellt Audit-Ereignisse und Verlaufsdetails deutsch dar',()=>{
    expect(auditEventLabel('customer.updated')).toBe('Kunde: geändert');
    expect(auditEventLabel('alarm.status_changed')).toBe('Alarm: Status geändert');
    expect(auditEventLabel('keys.exported')).toBe('Schlüssel: exportiert');
    expect(historyDetailText('customer_status','active')).toBe('Kundenstatus: Aktiv');
    expect(historyDetailText('is_primary',true)).toBe('Primärkontakt: Ja');
    expect(historyDetailText('reason',null)).toBe('Grund: Nicht verfügbar');
  });
});
