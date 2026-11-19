# Phase 7 UAT- und Abnahmeprotokoll

## Testdaten und Voraussetzungen

- Staging-Tenant mit Testobjekt, Testmitarbeiter, Gerät, Kontrollpunkt und NSL-Rolle.
- SMTP/SMS-Testadapter, keine echten Notrufempfänger.
- Abnahme-Commit/Tag, Datum, Prüfer und Umgebung im Protokoll ergänzen.

## Szenarien

| ID | Szenario | Erwartung | Ergebnis/Nachweis |
|---|---|---|---|
| UAT-01 | Anmeldung als Leitstelle | Tenant-sichere Anmeldung, CSRF und Rollen greifen | |
| UAT-02 | Panik-/Sensoralarm | Kritischer Alarm erscheint live, Historie und Audit sind vollständig | |
| UAT-03 | Quittierung/Eskalation | Quittierung stoppt Eskalation; Nicht-Quittierung eskaliert regelkonform | |
| UAT-04 | Einsatzworkflow | Einsatz anlegen, Kraft zuweisen, alle Statuswechsel mit Historie | |
| UAT-05 | Kontrollgang | NFC-Scan wird protokolliert; verspäteter/ausgelassener Scan erzeugt Abweichungsalarm | |
| UAT-06 | NSL und Benachrichtigung | Dashboard zeigt Alarme/Einsätze/Positionen; E-Mail/SMS im Testadapter | |
| UAT-07 | Bericht | Gefilterter Alarm-/Einsatzbericht als CSV/PDF abrufbar | |
| UAT-08 | Rechte/Mandanten | Fremdtenant und fehlende Berechtigungen werden abgewiesen | |
| UAT-09 | Backup/Restore | `scripts/restore-drill.sh` stellt isoliert wieder her und `/ready` ist verfügbar | |

## Freigabe

Abnahme ist bestanden, wenn alle Szenarien mit Nachweis bestanden sind, keine
kritischen Findings offen sind und Betriebsverantwortlicher sowie fachlicher
Verantwortlicher signiert haben. Abweichungen erhalten eine Frist, einen Owner
und eine explizite Go-live-Entscheidung.

Freigabe: ____________________  Datum: __________  Commit/Tag: __________

Fachlich: ____________________  Betrieb: __________  Datenschutz/Sicherheit: __________
