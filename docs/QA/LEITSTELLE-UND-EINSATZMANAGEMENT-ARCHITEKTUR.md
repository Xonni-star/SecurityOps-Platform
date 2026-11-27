# Architektur: Operative Leitstelle und Einsatzmanagement

## Geplante Architektur (vor Implementierung)

### Bestandsaufnahme

- Frontend: React/Router in `frontend/src/App.tsx`, Navigation in `frontend/src/components/Layout.tsx`, bestehende Dashboard-Vorlage `frontend/src/pages/NslDashboard.tsx`.
- Backend: Express-Router in `backend/src/app.ts`, RBAC via `requireAuth`/`requirePermission` und Scope-Prüfung in `backend/src/types/authorization.ts`, Mandantentrennung zusätzlich per RLS.
- Fachlogik: `backend/src/services/staffing-verdict.ts` + `staffing-eligibility.ts` (verbindliche Einsatzprüfung), `qualification-status-sql.ts` (Qualifikationszustände), `dms-document-status.ts` (Dokumentzustände). Diese Dienste bleiben die einzigen fachlichen Regelquellen.
- Daten: `employees`, `employee_qualifications`, `sites`, `schedule_*`, `dms_*`, `nfc_devices`, `keys`, `customer_tasks`, `alarms`, `incidents`, `notifications` sind bereits vorhanden.

### Operative Leitstelle

1. Neue additive Migration `066`: `operations_measures` für mandantenbezogene, quellenverknüpfte Maßnahmen inklusive Status, Priorität, Fälligkeit und RLS. Der bestehende `customer_tasks`-Datenstrom bleibt unberührt; er ist kundenbezogen und kennt weder Modulzuordnung noch die geforderten Statuswerte.
2. Neuer Backend-Router `backend/src/routes/operative-leitstelle.ts` mit:
   - `GET /operations/control-center` als einmalige, berechtigungsabhängige Aggregation (KPIs, Handlungsbedarfe, Tageseinsätze, Verfügbarkeit, Objekte, Qualifikationen, DMS, NFC/Schlüssel, Maßnahmen).
   - `GET /operations/control-center/candidates` für fachlich geprüfte Ersatzkandidaten; ausschließlich Lesevorschläge, keine Zuweisung.
   - `GET/POST/PATCH /operations/measures` für echte Maßnahmenbearbeitung. Das Abschließen einer quellenverknüpften Maßnahme prüft serverseitig erneut, ob die Ursache noch besteht (`409 source_open`).
3. Neue Seite `frontend/src/pages/OperativeLeitstelle.tsx`, plus Route/Navigation. Nur Serverdaten; 30-Sekunden-Aktualisierung nur bei sichtbarem Tab, manuelles Aktualisieren und WebSocket-Refresh. Frontend-Berechtigungen steuern nur Darstellungsdetails, nie den Datenzugriff.
4. Filter, Pagination, Leer-/Lade-/Fehlerzustände und Links in bestehende Detailseiten.

### Einsatz-, Alarm- und Vorfallmanagement

1. Bestehende `alarms`/`incidents`/`escalation_rules` werden erweitert statt neuer paralleler Vorgangstabellen. Neue additive Migration `067` ergänzt Vorgangsnummern, Vorfallarten (konfigurierbare Tabelle), Priorität, Kunden-/Verantwortlichkeitsfelder, Beteiligte, DMS-Anhänge, Bearbeitungsverlauf, Abschlussbedingungen, Alarm-Deduplizierung und Eskalationsprotokoll.
2. Neuer Router `backend/src/routes/incident-management.ts` für Vorfälle, Alarme, Maßnahmen, Eskalationen und Auswertungen. Automatische Ereignisse erzeugen Alarme nur mit stabilem `source_key` und eindeutigem aktiven Alarm; Bestätigung beseitigt nie die Ursache.
3. Benachrichtigungen laufen über den vorhandenen `queueNotificationEvent`-Dienst. Nicht konfigurierte externe Kanäle werden als „nicht versendet“ ausgewiesen, nie als erfolgreich.
4. Neue Oberfläche unter `/einsatz` mit Unterseiten für Vorfälle, Alarme, Maßnahmen, Eskalationen und Auswertungen; Verknüpfung zur Leitstelle über gemeinsame Aggregate und IDs.

### Gemeinsame Regeln

- Keine Änderung an Migrationen `001`–`065`; Checksums bleiben unverändert. Migrationen sind additiv und mandantensicher.
- Alle neuen Tabellen erhalten `(tenant_id, id)`-Indizes, composite FKs und `FORCE ROW LEVEL SECURITY`.
- Keine Produktionsmigration ohne ausdrückliche Freigabe; `iptv-android/` bleibt unangetastet.
