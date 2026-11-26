# Fehleranalyse – SecurityOps-Platform

Stand: 2026-11-26 · Branch: `fix/employee-master-data-save` · Basis: `9e924a1` (gemergter `master`, inkl. PR #56)

## Einordnung

- **REPRODUCIBLE:** Fehler im Codepfad nachvollzogen und durch Tests (HTTP, PostgreSQL, Frontend oder Browser) abgesichert.
- **CODE-DETECTED:** Statisch im Code erkannt; die Korrektur ist durch automatisierte Tests abgesichert, das konkrete Szenario wurde nicht einzeln im Browser nachgestellt.
- **RISIKO (CODE-DETECTED):** Statischer Befund ohne bestätigte Auswirkung im laufenden System; bewusst nicht im Rahmen dieses Bugfixes umgesetzt.

## Fehlerübersicht

| ID | Modul | Schweregrad | Kurzbeschreibung | Klassifikation | Status |
|---|---|---|---|---|---|
| F-001 | Mitarbeiter-Stammdaten | Kritisch | Speichern scheitert an strict API-Schema, keine Feld-/Erfolgsrückmeldung | REPRODUCIBLE | Behoben, verifiziert |
| F-002 | Formulare/API-Verträge | Hoch | Rohformulare bzw. leere Strings an strikte Zod-Schemata (Geräte, Admin, Mobile, Handover, DMS, Nachrichten, Alarmweiterleitung, Qualifikationen, Schichtplanung, Kunde) | CODE-DETECTED | Behoben, verifiziert |
| F-003 | Datenbank-Integrität | Hoch | Composite `ON DELETE SET NULL` ohne Tenant-Schlüssel und fehlender DMS-FK | CODE-DETECTED | Behoben, Migration 057, verifiziert |
| F-004 | Abwesenheiten/Schichtplanung | Hoch | Doppelbuchungssperre ignorierte stornierte/abgelehnte Abwesenheiten | CODE-DETECTED | Behoben, Migration 058, verifiziert |
| F-005 | Reporting | Mittel | Report-Filter nicht validiert, PDF-Xref ungültig, Tenant-Joins unvollständig | CODE-DETECTED | Behoben, verifiziert |
| F-006 | Audit/Logging | Mittel | Zod-Issues mit Werten geloggt, MFA-Challenge gab vollständigen User zurück | CODE-DETECTED | Behoben, verifiziert |
| F-007 | Navigation/Auth | Mittel | Client-Auth-Flag ohne Serverprüfung, Login-Route, kein 404, Berechtigungsmenü | CODE-DETECTED | Behoben, verifiziert |
| F-008 | Backup/Benachrichtigungen | Mittel | Falsche Berechtigung, undidempotente Regeln, unbereinigte Konfigurationsantworten | CODE-DETECTED | Behoben, verifiziert |
| F-009 | Zeitplanung | Mittel | `datetime-local`-Werte unsauber nach ISO konvertiert, fehlende Mutations-ID | CODE-DETECTED | Behoben, verifiziert |
| F-010 | Objekt-Chronik | Mittel | Kalenderdaten nicht geprüft | CODE-DETECTED | Behoben, verifiziert |

Summe: **1 reproduzierter kritischer Fehler**, **9 statisch erkannte Fehlergruppen** (alle behoben und durch Tests abgesichert), **13 verbleibende Risiken** (siehe unten).

---

## F-001 – Mitarbeiter-Stammdaten können nicht gespeichert werden (REPRODUCIBLE)

| Feld | Inhalt |
|---|---|
| Modul | Verwaltung → Mitarbeiter → Mitarbeiterakte → Stammdaten |
| Schweregrad | Kritisch |
| Fehlerbeschreibung | Das Speichern bestehender Mitarbeiterstammdaten wurde vom Backend mit `400 Invalid employee profile` abgewiesen. Die Oberfläche zeigte weder eine konkrete Fehlerursache noch einen Erfolg, bot keinen Ladezustand und verhinderte keine Doppelaufrufe. Die Audit-Zeile wurde außerhalb der Datenbanktransaktion geschrieben. |
| Reproduktion | Mitarbeiterakte öffnen → Reiter „Stammdaten“ → beliebiges Feld ändern → „Stammdaten speichern“ → generische 400; Wert bleibt nach erneutem Öffnen unverändert. |
| Ursache | `frontend/src/pages/EmployeeDetail.tsx` sendete `{...form, reason}` – die komplette Profilzeile inklusive `id`, `tenant_id`, `created_at`, `updated_at`, `account_email`, `account_role`. Das Backend nutzt in `backend/src/routes/employees.ts` ein `z.object({...}).strict()` und lehnt unbekannte Schlüssel ab. `api()` in `frontend/src/lib/api.ts` warf nur die generische `error`-Zeichenkette ohne Feldzuordnung. Zudem fehlten Lade-/Erfolgszustand, Doppel-Speicher-Schutz, serverseitige Datumskonsistenzprüfung und die Übergabe des Transaktionsclients an `recordAudit`. |
| Betroffene Dateien | `frontend/src/pages/EmployeeDetail.tsx`, `frontend/src/lib/api.ts`, `frontend/src/polish.css`, `backend/src/routes/employees.ts` |
| Korrektur | Frontend sendet ausschließlich die vom Endpunkt erlaubten Felder (`ProfilePayload`) inklusive `reason`; alle vorhandenen Werte werden mitgesendet, damit optionale Felder nicht unbeabsichtigt `null` werden. Backend liefert feldbasierte 400-Fehler (auch für unbekannte Schlüssel), prüft `Austritt >= Eintritt`, gibt `404`/`400` mit verständlicher Meldung und schreibt `employee_history` sowie `audit_events` im selben Transaktionsclient. UI: Pflicht-/Formatvalidierung, `aria-invalid`, Felderfehler, Ladezustand, Doppelklick-Sperre, Erfolgsmeldung, Abbrechen, Neuladen der gespeicherten Werte. |
| Tests | `backend/tests/employee-profile.test.ts` (9 HTTP-Tests), `backend/tests/employee-profile.integration.test.ts` (2 echte PostgreSQL-Tests), `frontend/tests/employees.test.tsx` (8 Tests), `e2e/employee-master-data.spec.ts` (Browser: Öffnen → Ändern → Speichern → Neuladen → Prüfen). |
| Status | Behoben; Backend/Frontend/PostgreSQL und Browser-E2E grün. |

## F-002 – Weitere Formular-/API-Vertragsbrüche (CODE-DETECTED)

Gemeinsame Ursache: FrontendFormulare senden entweder das gesamte Formularobjekt, leere Strings statt `null`/`undefined` oder Freitext statt UUID/Enum an ein striktes Backend-Schema. Betroffen waren:

- `/devices`: Freitext `status`/`site_id` → Enum `online|offline|maintenance` und UUID/null. **Korrektur:** dediziertes Geräteformular mit Status- und Objektauswahl, leere Objektwahl → `null`.
- Admin/SMTP, SMS, TimeScan, Backup-Ziele und -Regeln: geteilter Änderungsgrund, `secret_ref:''`. **Korrektur:** eigene `reason`-Felder je Formular, clientseitige Mindestlänge, bedingte `secret_ref`-Prüfung, leere Referenz wird weggelassen.
- Mobile/Push: `subscription.toJSON()` mit browserabhängigen Zusatzfeldern. **Korrektur:** explizite Projektion auf `endpoint` und `keys`.
- Mobile/Patrol-Scan, Kontrollgänge, Schichtplanung, DMS, Nachrichten, Schichtübergaben: Freitext-IDs. **Korrektur:** zentrale `isUuid()`-Prüfung in `frontend/src/lib/validation.ts` mit verständlicher Meldung vor dem Request; Schichtübergaben erzwingen genau eine Identität, Kontrollstellen folgen der fortlaufenden Nummer pro Objekt.
- Alarmaufschaltung: fehlende kanalabhängige Pflichtfelder und leere Filter. **Korrektur:** Endpoint/Empfänger/Secret bzw. Alarmtyp/Priorität clientseitig geprüft, gültige Ziel-UUID erforderlich.
- Qualifikationen: `valid_from:''` statt `null`. **Korrektur:** leere Daten werden zu `null`, Mitarbeiter-UUID geprüft, Lade-/Fehlerzustand ergänzt.
- Kunde/Ansprechpartner und Kunde/DMS: `customer_sites` liefert die Verknüpfungs-ID als `id` und die echte Objekt-ID als `site_id`. **Korrektur:** Auswahl und Upload verwenden konsequent `site.site_id` aus `profile.sites`; `contact.sites` behält seine echte Site-ID (`id`).

**Tests:** `frontend/tests/form-contracts.test.tsx` (4 Tests: Geräte-Payload, Webhook-Guard, Teilnehmeridentität, `valid_from:null`), `frontend/tests/app.test.tsx`, `npm run typecheck`, `npm run lint`. **Status:** Behoben, Frontend-Suite grün.

## F-003 – Datenbank-Integrität: tenantbezogene FKs (CODE-DETECTED)

`ON DELETE SET NULL` auf zusammengesetzten FKs ohne `tenant_id` konnte Löschvorgänge an `NOT NULL tenant_id` scheitern lassen. `dms_documents.responsible_employee_id` besaß wegen eines Constraint-Namenskollision keinen FK. **Korrektur:** neue Migration `057_tenant_fk_setnull_columns.sql` (bestandene Migrationen bleiben wegen Checksum-Prüfung unangetastet). **Test:** `backend/tests/employee-integrity.integration.test.ts` gegen echte PostgreSQL-Datenbank. **Status:** Behoben.

## F-004 – Abwesenheitsstatus in der Doppelbuchungssperre (CODE-DETECTED)

Der Trigger für Schichtzuweisungen berücksichtigte `employee_absences.status` nicht; stornierte/abgelehnte Abwesenheiten sperrten fälschlich. **Korrektur:** neue Migration `058_absence_status_double_booking.sql`. **Test:** `backend/tests/employee-integrity.integration.test.ts`. **Status:** Behoben.

## F-005 – Reporting (CODE-DETECTED)

`phase5Router` nahm ungültige Filter-UUIDs an (`reports/:kind`), mehrere Joinsohn Tenant-Prädikat konnten mandatsfremde Daten liefern, und die eingebetteten PDFs hatten einen fest codierten `startxref:0` sowie eine falsche `/Length` bei Umlauten. **Korrektur:** UUID-Validierung (`Invalid report filter`), Tenant-Joins, zentraler PDF-Generator `backend/src/services/pdf.ts` mit aus dem finalen Buffer berechneten Offsets und Byte-Längen; auch der Alarm-Report in `phase4.ts` nutzt ihn. **Tests:** `backend/tests/phase5.test.ts` (400 bei `site_id=not-a-uuid`, PDF-Xref auditierbar). **Status:** Behoben.

## F-006 – Audit- und Auth-Datenhaltung (CODE-DETECTED)

Zod-Fehler wurden inklusive Werte geloggt; der MFA-Challenge gab den vollständigen User zurück; `Login.tsx` reagierte nur auf `mfa_required`. **Korrektur:** `middleware/errors.ts` loggt nur Issue-Pfade/Codes, `auth.ts` gibt eine User-Projektion zurück, `Login.tsx` akzeptiert `mfa_required || mfa_pending`. **Status:** Behoben.

## F-007 – Navigation und Sitzungsprüfung (CODE-DETECTED)

`App.tsx` vertraute dem lokalen Auth-Flag und leitete unbekannte Pfade still auf das Dashboard um; `/login` war auch bei aktiver Sitzung erreichbar; `Layout.tsx` nutzte das falsche Recht für `/customer-reports` und markierte `/keys/:keyId` nicht als aktiven Menüpunkt. **Korrektur:** `/auth/me`-Prüfung vor geschützten Routen, `LoginRoute`, echtes `NotFound`, korrigierte Berechtigung und Menümarkierung. **Tests:** `frontend/tests/app.test.tsx` (Session-Clear, 404, Direktroute). **Status:** Behoben.

## F-008 – Backup und Benachrichtigungen (CODE-DETECTED)

„Als gelesen markieren“ nutzte das falsche Recht; Backup-Ziele ließen Site-Scope fälschlich zu; `backups.ts` sanitisierte `config` nur auf Leseantworten; Benachrichtigungsregeln waren nicht idempotent. **Korrektur:** `notifications:write`, Site-Scope nur bei `customers:write`, Sanitierung auch auf Write-Responses, `pg_advisory_xact_lock` mit Select-Update-Insert ohne Löschen bestehender Zeilen (keine Migration 059). **Status:** Behoben.

## F-009 – Planung und Zeitfenster (CODE-DETECTED)

`Scheduling.tsx` sendete `datetime-local`-Strings direkt und ohne `client_mutation_id`; `scheduling.ts` akzeptierte keine Idempotenz-ID. **Korrektur:** lokale Werte behalten, Konvertierung erst beim Senden, `client_mutation_id` serverseitig akzeptiert. **Status:** Behoben.

## F-010 – Objekt-Chronik (CODE-DETECTED)

`object-chronicle.ts` vertraute ungeprüften Kalenderwerten. **Korrektur:** Validierung echter Kalenderdaten. **Status:** Behoben.

## Verbleibende Risiken (CODE-DETECTED, nicht in diesem Bugfix umgesetzt)

| ID | Risiko | Bewertung |
|---|---|---|
| R-001 | Fehlende Page-Level-Permission-Guards in einzelnen Seiten | Mittel – API erzwingt Rechte, UI zeigt ggf. unbedienbare Formulare |
| R-002 | Write-Buttons ohne UI-Berechtigungsprüfung | Mittel – Server lehnt ab, UX nicht konsistent |
| R-003 | Ungeschütztes `JSON.parse()` in mehreren WebSocket-Handlern | Mittel – fehlerhafte Frames können Handler unterbrechen |
| R-004 | Dashboard-Normalisierung uneinheitlich | Niedrig – Darstellungsrisiko |
| R-005 | Stale Error-States in mehreren Formularen | Niedrig – Fehlermeldung bleibt nach späterem Erfolg stehen |
| R-006 | Unvollständiges Dark-Theme/Topbar-CSS | Niedrig – rein visuell |
| R-007 | Direkte Download-Links ohne `ApiError`-Behandlung | Niedrig – generische Fehlermeldung möglich |
| R-008 | MFA-Enrollment-UI nicht erreichbar | Mittel – Workflow nur über API |
| R-009 | TOCTOU bei Statusübergängen und Abwesenheits-PATCH | Mittel – konkurrierende Requests nicht vollständig serialisiert |
| R-010 | Nicht-transaktionale TimeScan-/Patrol-Pfade | Mittel – teilweise Resultate bei Fehler möglich |
| R-011 | Origin-Pflicht nicht überall aktiv | Mittel – CSRF-Token bleibt primäre Absicherung |
| R-012 | MFA-Policy-Lese-Berechtigung nicht modelliert | Niedrig |
| R-013 | Kein einheitlicher `useMutation`-Helper für `saving`/`error`/`success` | Niedrig – mehrere Formulare ohne Ladezustand |

Diese Punkte sind **nicht** als gelöst dokumentiert und bleiben für eine follow-up-QA-Bearbeitung erhalten. Sie standen nicht im Zusammenhang mit dem Stammdaten-Bug und wurden nicht durch neue Module, Tabellen oder parallele Strukturen „gelöst“.

## Nicht als Fehler gewertete Beobachtungen

- Felder wie Geschlecht, Anrede, Postleitzahl, Ort, Notfallkontakt, interne Bemerkungen und Vorgesetzter existieren im bestehenden Datenmodell nicht. Es wurden bewusst **keine** neuen Spalten/Tabellen eingeführt; die Anschrift wird im vorhandenen Feld `employees.address` gepflegt, der Benutzerbezug über `user_id`.
- Bestehende Migrationen wurden nicht verändert (Checksum-Prüfung in `backend/src/db/migration-runner.ts:133-138`); Reparaturen erfolgen ausschließlich über neue Migrationen.
- RBAC, RLS/FORCE-ROW-LEVEL-SECURITY, Audit, API-Endpunkte, Navigation und Layout blieben erhalten; es gibt keine zweite Sidebar, keine zweite Datenbank und keine Mock-Speicherung.
