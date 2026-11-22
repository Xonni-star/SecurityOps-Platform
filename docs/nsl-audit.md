# NSL-Audit – Umsetzungsprüfung

Stand: 2026-11-22  
Basis: `xonni-star-objektmanagement-stammdaten`  
Prüfumfang: reale Backend-Routen, Datenbankmigrationen, Frontend-Anbindung, Berechtigungs- und Tenant-Filter, vorhandene Tests und E2E-Spezifikationen.

## Status-/Gap-Matrix

| Funktion | Status | Nachweis | Problem / Gap | Maßnahme |
|---|---|---|---|---|
| Alarmmanagement | TEILWEISE | `backend/src/routes/phase2.ts`, Migration `004`, `phase2.test.ts`, `e2e/phase4.spec.ts` | Erstellen, Speichern, Quittieren, Abschluss und Historie sind angebunden; reale DB-/E2E-Ausführung war ohne Fixture nicht möglich. | Alarmstatus und Historie werden jetzt atomar transaktional geschrieben; E2E bleibt offen zu verifizieren. |
| Alarmdetail | TEILWEISE | `GET /api/v1/nsl/alarms/:id` liefert Alarm plus `alarm_history`. | Keine dedizierte Frontend-Detailansicht; Objektanweisungen/Kontakte werden dort nicht geladen. | P1: Detail- und Kontextansicht ergänzen. |
| Eskalationen | TEILWEISE | `backend/src/services/escalation.ts`, `escalation_rules`, Worker in `server.ts`. | Regeln und Worker existieren, aber keine erkennbare NSL-Bedienoberfläche; Worker verwirft Fehler still. | P1: Fehler sichtbar/auditierbar machen und UI ergänzen. |
| Einsatzmanagement | TEILWEISE | `backend/src/routes/phase3.ts`, `incidents`, Statushistorie, `frontend/src/pages/Incidents.tsx`. | Statuspfad und Zuweisungs-API existieren; Zuweisung ist in der UI nicht bedienbar. | P1: echte Dispositions- und Zeitansicht ergänzen. |
| Disposition | TEILWEISE | Incident-Assignment-Route sowie Scheduling-Routen/Migrationen. | Kein durchgängiger Leitstellen-Workflow von Alarm zu Einsatz und Mitarbeiterzuweisung in der UI. | P1: Alarm→Einsatz→Zuweisung Ende-zu-Ende testen und bedienen. |
| Einsatzkräfte | TEILWEISE | Mitarbeiter-CRUD, Patrol-/Scheduling-Tabellen und Tenant-FKs. | Verfügbarkeit ist nur über Dienstplanung/Abwesenheiten modelliert; keine NSL-Verfügbarkeitsübersicht. | P1: verfügbare Kräfte und Einsatzzeiten in der Leitstelle anzeigen. |
| Objektverknüpfung | TEILWEISE | `object-management.ts`, `GET /sites/:id/object-context`, Alarm-Site-Joins. | Kunden-/Vertragskontext ist persistent, aber nicht in der Alarmdetail-UI ohne Navigation sichtbar. | P1: Alarmkontext direkt einblenden. |
| Kommunikation | TEILWEISE | `phase4.ts`, `direct_messages`, Notifications und Frontend-Seiten. | Nachrichten sind nicht mit Alarmen/Einsätzen/Aufgaben als Vorgang verknüpft; keine bestätigte Zustellung als NSL-Prozess. | P2: Vorgangsbezug und Zustellstatus ergänzen. |
| Vorfälle | TEILWEISE | `phase3.ts`, `incidents`, `incident_history`, `Incidents.tsx`. | Kernstatus ist vorhanden; Bearbeitung/Abschlussnotizen und vollständige Detailansicht fehlen. | P1: Vorgangsdetails und Abschlussnachweis ergänzen. |
| Aufgaben und Maßnahmen | NICHT IMPLEMENTIERT | Keine NSL-Task-Tabelle, Route oder Seite gefunden. | Aufgaben aus Alarmen/Einsätzen, Fristen, Zuweisung und Abschluss fehlen. | P1: eigenes persistentes Aufgabenmodell und Rechte einführen. |
| Schichtübergabe | TEILWEISE | `handovers.ts`, `phase4.ts`, Migration `019`/`006`, `Handovers.tsx`. | Append-only-Protokoll und Bestätigungen existieren; die ältere Übergabe speichert nur JSON-Snapshots und die UI bindet Vorgänge nicht automatisch ein. | P1: offene Alarme/Einsätze/Aufgaben als verknüpfte, weiterhin bearbeitbare Vorgänge übernehmen. |
| Leitstellenjournal | TEILWEISE | Watchbook-Routen, Integritätsprüfung und `Watchbook.tsx`. | Wachbuch ist persistent und geschützt, aber nicht als NSL-Journal mit Alarm-/Einsatzverknüpfung nachgewiesen. | P2: NSL-Vorgangsbezug ergänzen. |
| Echtzeitaktualisierung | TEILWEISE | WebSocket in `server.ts`, `realtime.ts`, Dashboard-/Operations-Listener. | Aktualisierung erfolgt per Event plus erneutem GET; kein Reconnect/Backoff, keine verlässliche Stale-/Offline-Anzeige, keine vollständige Scope-Prüfung je Site im Event-Payload. | P1: robuste Verbindung und scope-sichere Events ergänzen. |
| Kartenansicht | TEILWEISE | `phase3.ts` `map-data`, `LiveMap.tsx`, Positionspersistenz. | Aktuelle Positionen/Alarme werden geliefert; Kartenfunktion ist nicht als vollständiger Einsatz-/Objektworkflow verifiziert. | P2: Objekt-/Einsatzlayer und Fehlerzustände ergänzen. |
| SLA und Reaktionszeiten | TEILWEISE | Alarmalter `age_seconds`, Eskalationsverzögerungen, Reporting. | Kein eigenständiges SLA-Modell, keine gemessenen Reaktions-/Quittierzeiten und keine SLA-Auswertung. | P1: SLA-Regeln, Messpunkte und Bericht einführen. |
| Fehlalarmmanagement | NICHT IMPLEMENTIERT | Keine Fehlalarm-Entität, Route oder UI gefunden. | Kennzeichnung, Begründung, Auswertung und Audit fehlen. | P1: Fehlalarmstatus und Auswertung ergänzen. |
| NSL-Einstellungen | TEILWEISE | Alarmprioritäten/Eskalationsregeln und Admin-/Settings-Routen. | Einstellungen sind verteilt; kein konsolidierter NSL-Konfigurationsbereich und keine vollständige Bedienoberfläche für alle NSL-Funktionen. | P2: NSL-Einstellungen bündeln. |
| Rollen und Berechtigungen | TEILWEISE | `auth.ts`, `authorization.ts`, Migrationen `010`/`011`, Tenant-Isolation-Tests. | Serverseitige Auth/RBAC/Tenant-FKs/RLS sind vorhanden; viele NSL-Routen akzeptieren standardmäßig nur Tenant/System und unterstützen Site-Scopes dadurch nicht konsistent. | P1: Scope-Matrix für alle NSL-Endpunkte vervollständigen, ohne Zugriffsrechte auszuweiten. |
| Sicherheit | TEILWEISE | CSRF, Origin-Prüfung, MFA, Session-/Device-Bindung, Audit-Events, RLS. | Sicherheitsmechanismen sind real vorhanden; ein vollständiger Live-IDOR-/Cross-Tenant-Test gegen laufende PostgreSQL-Instanz konnte nicht ausgeführt werden. | P1: isolierte Integrationssicherheits-Suite und sichtbare Worker-Fehler ergänzen. |
| Tests | TEILWEISE | Backend: 33 Suites bestanden, 107 Tests bestanden, 7 übersprungen; Frontend: 4 Tests bestanden; E2E: 6 Tests aufgelistet, nicht ausgeführt. | Backend-Tests mocken überwiegend SQL statt reale Persistenz; E2E benötigt isolierte Fixture-Credentials/Services. | Folgephase: DB-Integration und E2E mit isolierter Fixture ausführen. |

## Behobener kritischer Fehler

Quittierung und Abschluss eines Alarms änderten den Datensatz und schrieben den Historieneintrag in getrennten Datenbankoperationen. Ein Fehler beim Historieneintrag konnte dadurch einen neuen Alarmstatus ohne nachvollziehbare Historie hinterlassen. Beide Übergänge verwenden jetzt `withTransaction`; der Abschluss sperrt den aktuellen Datensatz zusätzlich mit `FOR UPDATE`. Ein Regressionstest deckt den Fehlerpfad ab.

## Priorisierte offene Punkte

### P0 – kritisch

Keine weiteren P0-Punkte nach dem transaktionalen Fix wurden im geprüften Codepfad belastbar nachgewiesen. Ein Live-Sicherheitslauf gegen eine isolierte PostgreSQL-/Fixture-Umgebung steht noch aus und ist deshalb nicht als bestanden zu werten.

### P1 – wichtig

1. Aufgaben/Maßnahmen fehlen als persistenter, berechtigter Prozess.
2. Alarmdetail, Disposition, Mitarbeiterverfügbarkeit und Objektkontext sind nicht als durchgängiger Leitstellenworkflow verbunden.
3. Schichtübergaben müssen offene Vorgänge als verknüpfte Datensätze übernehmen, nicht nur als JSON-Snapshot.
4. Site-scoped Berechtigungen und WebSocket-Events müssen über alle NSL-Endpunkte konsistent geprüft/gefiltert werden.
5. Fehlalarmmanagement und ein echtes SLA-/Reaktionszeitmodell fehlen.
6. Eskalations-/Realtime-Fehler dürfen nicht still verworfen werden.
7. Echte PostgreSQL-Integrations- und Browser-E2E-Läufe mit isolierter Fixture fehlen als Nachweis.

### P2 – Verbesserungen

1. NSL-Einstellungen, Journalbezug, Kartenlayer, Filter und Berichte konsolidieren.
2. Kommunikation mit Alarm-/Einsatzbezug und Zustellstatus erweitern.
3. Realtime-Reconnect, Stale-Anzeige und Offline-UX verbessern.

## Testbericht

| Test | Ergebnis | Hinweis |
|---|---|---|
| `npm run typecheck` | BESTANDEN | Backend und Frontend ohne TypeScript-Fehler. |
| `npm run build` | BESTANDEN | Backend kompiliert; Frontend-Vite-Build erfolgreich. |
| `npm run test -w backend -- --runInBand` | BESTANDEN | 33 Suites bestanden, 107 Tests bestanden, 7 Tests übersprungen, 3 Suites übersprungen. |
| `npm test -w frontend` | BESTANDEN | 4 Tests bestanden; veraltete englische Selektoren wurden an die bestehende deutsche UI angepasst. |
| `npm run e2e -- --list` | BESTANDEN | 6 E2E-Tests erkannt. |
| Browser-E2E-Ausführung | NICHT VERIFIZIERT | Erfordert isolierte Fixture-Credentials und laufende Services; keine erfundenen Ergebnisse. |
| PostgreSQL-Integration gegen reale Daten | NICHT VERIFIZIERT | In dieser Prüfung war keine isolierte laufende DB-Fixture verfügbar. |

## Zusammenfassung

- Vollständig: **0**
- Teilweise: **18**
- UI-only: **0**
- Nicht implementiert: **2**
- Fehlerhaft: **0 offene** (1 kritischer Integritätsfehler behoben)
- Nicht verifiziert: **2 Nachweisarten** (Browser-E2E, reale PostgreSQL-Integration)

