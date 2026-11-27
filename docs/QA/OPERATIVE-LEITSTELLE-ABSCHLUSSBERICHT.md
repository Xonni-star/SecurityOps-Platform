# Abschlussbericht – Operative Leitstelle

Datum: 2026-11-28 · Branch: `feature/operative-leitstelle` · Basis: `a689271`

## 1. Ziel

Eine vollständig funktionsfähige operative Leitstelle mit echten Backend-Daten, ohne Demo-, Statik- oder Kunstkennzahlen. Alle KPIs, Warnungen, Listen und Aktionen stammen aus vorhandenen Fachdaten und vorhandenen Geschäftsprozessen. Die frontendseitige Sichtbarkeit ist ausschließlich UI-Gating; die Sicherheitsgrenze liegt serverseitig.

## 2. Verbindliche Regelquellen

- `backend/src/services/staffing-verdict.ts` / `staffing-eligibility.ts` bleiben die einzige Einsatzprüfung. Kandidatenvorschläge werden ausschließlich über `/operations/control-center/candidates` geliefert; die Leitstelle trifft keine eigene Besetzungsentscheidung.
- `backend/src/services/qualification-status-sql.ts` bleibt die zentrale SQL-Klassifikation für Qualifikationen. Der CTE wurde nur um die Primärschlüsselspalte `qualification_id` erweitert, damit historische Zuordnungen mit gleichem natürlichem Schlüssel eindeutig zugeordnet bleiben. Es wurde keine zweite Statuslogik eingeführt.
- `backend/src/services/dms-document-status.ts` bleibt die Regelquelle für Dokumentstatus und Freigabe. DMS-Verweise zeigen nur auf die erlaubten Versions-Endpunkte.
- `sourceStillOpen()` in `operations-control-center.ts` verwendet diese Dienste erneut, bevor eine quellenverknüpfte Maßnahme abgeschlossen werden darf.

## 3. Datenmodell und Migrationen

- Neu: `backend/migrations/066_operations_measures.sql` mit `operations_measures`, RLS, `source_key`-Dedupe, Indizes und Auditfeldern.
- Neu: `backend/migrations/067_incident_management.sql` und `068_incident_type_bootstrap.sql` für die eng verknüpfte Einsatzdomäne.
- Die Migrationen `001`–`065` blieben unverändert. Eine frische Datenbank wurde erfolgreich bis `068` migriert.
- Die zuvor festgestellte Checksummen-Abweichung von `066` in den lokalen QA-Datenbanken wurde behoben (`470f2b4c…`); Produktionsdaten wurden nicht verändert.
- Neue Permissions: `operations_measures:read` (`…0901`) für admin/operator/viewer/superadmin und `operations_measures:write` (`…0902`) nur für admin/operator/superadmin.

## 4. Backend

- `backend/src/routes/operative-leitstelle.ts`:
  - `GET /operations/control-center` – eine autorisierte Aggregation für KPIs, Handlungsbedarfe, Schichten, Verfügbarkeit, Objekte, Qualifikationen, DMS, NFC/Schlüssel und Maßnahmen.
  - `GET /operations/control-center/candidates` – fachlich geprüfte Ersatzkandidaten, ohne Zuweisung.
  - `GET/POST /operations/measures` und `PATCH /operations/measures/{id}` – echte Maßnahmenbearbeitung mit Idempotenz, Filter, Pagination, Audit und `409 reason_code='source_open'`, solange die Ursache fortbesteht.
- `backend/src/services/operations-control-center.ts`:
  - Alle Member werden über autorisierte `siteClause`/`employeeClause` gefiltert; nicht lesbare Bereiche erscheinen weder in KPIs noch in Warnungen.
  - Quellenverknüpfte Maßnahmen werden beim Abschluss erneut gegen die echte Ursache geprüft: Qualifikation, DMS-Freigabe/-Version, NFC-Status, Schlüsselstatus und verknüpfter Vorfall.
  - Ein alarmquittieren beseitigt nie die Alarmursache; der Alarm bleibt in den Warnungen sichtbar.
- Die Router authentifizieren nur ihre eigenen Pfade (`/operations/…`) und greifen nicht global in fremde Routen ein.

## 5. Frontend

- Neue Seite `frontend/src/pages/OperativeLeitstelle.tsx` mit Kennzahlen, sofortigem Handlungsbedarf, Tagesübersicht, Verfügbarkeit, Objektstatus, Qualifikationen/Nachweisen, NFC-/Schlüsselstatus und offenen Maßnahmen.
- Filter: Datum, Objekt, Kunde, Mitarbeiter, Suche, Maßnahmen-Modul, Maßnahmenstatus, nur überfällige Maßnahmen und Seitengröße. Pagination, Leer-/Lade-/Fehlerzustände und manuelles Aktualisieren sind enthalten.
- Echte Statuswechsel laufen über den Dialog „Status ändern“ mit Begründung. Nach dem Speichern wird die Liste aus dem Backend neu geladen.
- `frontend/src/lib/useRealtimeRefresh.ts` aktualisiert bei sichtbarem Tab und WebSocket-Ereignissen; Frontend-Permissions steuern nur die Darstellungsdetails.
- Responsive Tabellenkarten und getestete viewportstabile Ansichten bei 390 px und 768 px ohne horizontalen Dokumentüberlauf.

## 6. Berechtigung und Mandantentrennung

- Viewer sieht die Leitstelle lesend, jedoch keine Schreibaktionen; ein echter `POST /operations/measures` aus dem Browser wurde mit `403` abgewiesen.
- Ein fremder Mandant sah keine Maßnahmen des Fixture-Mandanten. Ein `PATCH` auf eine Maßnahme des Fixture-Mandanten wurde mit `404` und `Maßnahme nicht gefunden` abgewiesen.
- Alle neuen Tabellen sind per RLS geschützt; der Server filtert zusätzlich nach `tenant_id` und Berechtigungsscope.

## 7. Tests

- Backend: **69 Suites / 642 Tests grün**, inklusive `operations-control-center.integration.test.ts`, `operative-leitstelle.test.ts` und `openapi-coverage.test.ts`.
- Frontend: **17 Dateien / 184 Tests grün**.
- E2E gesamt: **50/50 grün**, davon sechs Leitstellen-Tests inklusive Idempotenz, `source_open`, RBAC, Fremdmandant, UI-Statuswechsel und Responsive-Check.
- `npm run typecheck`, `npm run lint` und `npm run build` grün. Der Vite-Hinweis auf einen Chunk > 500 kB ist eine bestehende, nicht funktionsbeeinträchtigende Build-Warnung.

## 8. Während der Browserabnahme behobener Defekt

Beim echten Statuswechsel einer Maßnahme meldete React `Encountered two children with the same key`. Ursache war nicht die UI, sondern die Backend-Aggregation: `qualificationStatesCte()` erzeugte pro historischer Qualifikation einen Zustand, die Leitstellenabfrage joinede jedoch über den natürlichen Schlüssel zurück. Bei zwei historischen Einträgen mit gleichem Code/Katalog/Gültig-bis erschien dieselbe `qualification_id` mehrfach.

Behebung: Der zentrale CTE liefert jetzt `qualification_id`, und die Leitstellenabfrage joinedt über die Primärschlüssel-ID. Ein PostgreSQL-Integrationstest legt bewusst zwei historische Qualifikationen mit identischem natürlichem Schlüssel an und verlangt eindeutige IDs sowie die Zustände `revoked` und `invalid`. Nach dem Fix liefert der echte Browser-Endpunkt 159 Qualifikationen ohne Duplikate; die Konsole ist nach Reload fehlerfrei.

## 9. Browserabnahme

- Echter Login als Operator, echte Leitstelle mit echten Daten; alle relevanten `/api/v1/operations/*`-Aufrufe `200`.
- Anlage einer echten Maßnahme über die API, Suche über den UI-Filter, Statuswechsel über den echten Dialog mit Begründung und sichtbarer Statusänderung in der Tabelle.
- Rollenprüfung als Viewer: Lesedaten sichtbar, keine Schreibbuttons, API-Schreibversuch `403`.
- Mandantenprüfung im Browser mit frischer `device_id`: eigene Daten des Fixture-Tenant, fremder Tenant ohne measures, cross-tenant `PATCH` `404`.
- Konsole nach dem Fix ohne Fehler; Netzwerk ohne unerwartete 4xx/5xx. Die einzigen 403/404 waren die bewusst ausgelösten RBAC-/Mandantenproben.
- Screenshots: `docs/QA/screenshots/operative-leitstelle.png` sowie die Einsatz-Screenshots unter demselben Verzeichnis.

## 10. Offene Punkte

- Externe Benachrichtigungskanäle sind nicht konfiguriert; die Anwendung weist Betroffene korrekt als „nicht versendet“ aus und behauptet keinen erfolgreichen Versand.
- Eine Produktionsmigration wurde ohne ausdrückliche Freigabe nicht ausgeführt; Produktionsdaten wurden nicht verändert.
- Für den Mandantenwechsel im selben Browser wurde ein API-Login mit frischer `device_id` verwendet, weil die Browser-Geräteidentität an den Fixture-Mandanten gebunden ist. Die fachliche Mandantentrennung wurde über echte Browser-Requests geprüft.
- `iptv-android/` blieb vollständig unangetastet und wird nicht gestagt.
