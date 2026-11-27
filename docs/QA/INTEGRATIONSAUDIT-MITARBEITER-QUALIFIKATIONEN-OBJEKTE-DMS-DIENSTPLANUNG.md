# Integrationsaudit: Mitarbeiter · Qualifikationen · Objekte · DMS · Dienstplanung

Prüfstand: 27.11.2026  
Branch: `fix/integration-audit-operations`  
Ausgangsbasis: `origin/master` / Merge-Commit `d42f279` (PR #66)  
Berichtsumfang: Backend, Frontend, E2E, Browserabnahme, Deployment-Vorbereitung

## A Gesamtbewertung

Die durchgängige operative Kette **Mitarbeiter → Qualifikation → Objektanforderung → Nachweis (DMS) → Dienstplaneinsatz** ist nach den Korrekturen funktional und serverseitig verbindlich. Die zentrale Einsatzprüfung wird sowohl im Leseweg (`/sites/:id/shifts/:shiftId/eligibility`) als auch im Schreibweg (`POST /scheduling/shifts/:shiftId/assignments`) angewendet. Eine Umgehung durch direkte Zuweisung ist nicht mehr möglich; Ablehnungen enthalten `reason_code` und strukturierte `details`.

Die Qualifikationsstatuslogik ist zentralisiert (`qualification-status-sql.ts`) und wird von Qualifikationsübersicht, Mitarbeiterübersicht, Dashboard und Nachweisbewertung gemeinsam genutzt. Der zuvor beobachtete Widerspruch („Abgelaufen“ in der Übersicht bei gleichzeitig gültiger Einzelqualifikation) ist behoben; die Übersicht zeigt nun den fachlich schwerwiegendsten Zustand.

Der DMS-Freigabeworkflow bleibt ausschließlich über die bestehenden Endpunkte wirksam. Es gibt keine Datenbankfreigabe, keine Umgehung von Virenprüfung, Quarantäne, Versionierung oder Zugriffsschutz. Eine neue Dokumentversion entzieht die bisherige Freigabe in derselben Transaktion und auditiert diesen Vorgang. Downloads und Previews verlangen eine freigegebene Version.

Die Mandantentrennung ist in den geprüften Pfaden wirksam. Rollen mit fehlenden Schreibrechten erhalten `403`; fremde Mandantenobjekte werden als `404` gemeldet. Die Browserabnahme mit Admin- und Operatorrolle zeigte keine unerwarteten Konsolenfehler und keine sichtbaren Umgehungswege.

**Gesamtbewertung: Erfolgreich getestet (QA/Staging); Nicht getestet (Produktion).** Die lokale/QA-Umgebung ist freigabefähig. Produktionsprüfungen und Produktionskorrekturen wurden mangels Zugang **nicht durchgeführt**.

## B Fehler

### B1 Hoch: Verbindliche Einsatzprüfung im Schreibweg fehlte

`POST /scheduling/shifts/:shiftId/assignments` prüfte zwar Zeiträume, Abwesenheiten und Überschneidungen, aber nicht die fachliche Einsatzfähigkeit. Ein Mitarbeiter ohne Pflichtqualifikation, mit abgelaufener/widerrufener Qualifikation, falschem Beschäftigungsstatus oder fehlender Objektzuordnung konnte direkt zugewiesen werden.

### B2 Hoch: Qualifikationsstatus war uneinheitlich aggregiert

Die Mitarbeiterübersicht nutzte eine lokale Näherung (`q.status IN ('expired','revoked','invalid')`) und meldete bei mehreren Zuordnungen pauschal „Abgelaufen“. Das Profil zeigte für dieselbe Person „Läuft bald ab“. Zusätzlich wurde der Nachweisstatus teilweise aus `approval_status` statt aus `document_status` abgeleitet.

### B3 Hoch: DMS-Freigabe konnte durch neue Version unterlaufen werden

Beim Upload einer neuen Version blieb `approval_status='approved'` bestehen. Damit konnte ein nicht geprüfter Inhalt unter dem alten Freigabestempel erscheinen.

### B4 Hoch: DMS-Download/Preview prüfte die Freigabe nicht

`loadDmsVersionForRead()` prüfte Objektstatus, Mandant, Kundendokumentberechtigung, Standortzugriff und `lifecycle_state`, aber nicht `approval_status`. Eine gescannte, aber nicht freigegebene Version war mit `dms:read` lesbar.

### B5 Hoch: Mitarbeiter-Stammdaten hatten einen parallelen generischen CRUD-Weg

`app.ts` mountete `crudRouter('employees')` zusätzlich zum domänenspezifischen `employeesRouter`. Der generische Weg erlaubte Anlegen, Ändern und physisches Löschen ohne Pflichtbegründung, ohne `employee_history`, ohne Datumsvalidierung und ohne `user_id`-Mandantenprüfung.

### B6 Hoch: Keine einheitliche Beschäftigungsprüfung außerhalb der Dienstplanung

Erinnerungen für ablaufende/ungültige Qualifikationen filterten nur bei fehlenden Pflichtqualifikationen auf `active|probation`. Ausgeschiedene oder noch nicht eingetretene Mitarbeiter konnten weiterhin Erinnerungen erzeugen. Status, `hire_date` und `termination_date` wurden nicht konsistent kombiniert.

### B7 Mittel: Nachweiszugriff wurde nicht auditiert

Der dedizierte Qualifikations-Nachweisendpunkt gab Download- und Preview-URLs zurück, ohne den Zugriff mit Grund, Version und Mitarbeiterbezug zu protokollieren.

### B8 Mittel: Profil gab DMS-Metadaten ohne `dms:read` preis

`/employees/:id/profile` lieferte Dokumenttitel, Versionen und Nachweisstatus unabhängig von der DMS-Leseberechtigung.

### B9 Mittel: Weitere DMS-Schwachstellen

`request-review` und `return-for-revision` prüften Kundendokumentrechte nicht konsistent. Die Freigabe konnte durch eine neueste nicht verfügbare Version blockiert werden. Versions-Uploads waren nicht idempotent. Archivieren/Löschen von Dokumenten fehlten im API-Wege.

### B10 Mittel: Objektabdeckung war headcount-basiert

Die Anforderungsbewertung zählte Mitarbeitende, statt die verbindliche Einsatzprüfung zu verwenden. `requirement_count` wurde pro Zeile nicht korrekt auf die einzelne Anforderung bezogen. Warnungs- und Prioritätslogik waren dupliziert.

### B11 Mittel: Geplante Einsätze wurden nach Änderungen nicht reevaluiert

Widerruf, Austritt oder geänderte Objektanforderungen ließen bereits geplante künftige Einsätze unbemerkt bestehen.

### B12 Niedrig: Statusvokabular und UI filtering

Neue Statuswerte (`widerrufen`, `ungültig`, `nachweis fehlt`, `prüfung ausstehend`, `noch nicht gültig`) hatten keine Labelzuordnung; `archived` fehlte im Mitarbeiterfilter; die CSS-Klasse `expired` deckte nicht alle problematischen Statuswerte ab. Die Reason-Codes `employment_not_started` und `employment_ended` hatten keine deutsche Beschriftung.

## C Korrekturen

| Fehler | Korrektur | Dateien |
|---|---|---|
| B1 | Gemeinsame Lade-/Prüflogik `staffing-verdict.ts`; verbindliche Prüfung vor dem `INSERT`; `409` mit `reason_code`, `details.reasons`, `details.missing_qualification_codes`; `errors.ts` gibt strukturierte Fehler zurück | `backend/src/services/staffing-verdict.ts`, `backend/src/routes/scheduling.ts`, `backend/src/middleware/errors.ts` |
| B2 | Zentrale SQL-Klassifikation; Overview/Dashboard nutzen dieselben Zustände und Schweregrade; `d.document_status` statt `approval_status`; deutsche Statuswerte | `backend/src/services/qualification-status-sql.ts`, `backend/src/routes/qualifications.ts`, `backend/src/routes/employees.ts`, `frontend/src/lib/status.ts`, `frontend/src/pages/Employees.tsx` |
| B3 | Freigabe wird beim Versions-Upload in derselben Transaktion entzogen und auditiert | `backend/src/routes/dms.ts`, `backend/tests/dms-upload.test.ts` |
| B4 | Download/Preview verlangen `approval_status='approved'`; `latest` bleibt `400` | `backend/src/routes/dms.ts`, `backend/tests/dms-upload.test.ts` |
| B5 | Generischer Employee-CRUD aus `app.ts` entfernt; domain POST/PATCH/GET mit Begründung, Historie, Auditing und Mandantenprüfung | `backend/src/app.ts`, `backend/src/routes/employees.ts`, `backend/tests/security.test.ts`, `backend/tests/employee-profile.test.ts` |
| B6 | Einheitlicher aktiver Beschäftigungszeitraum in allen drei Erinnerungsabfragen | `backend/src/services/qualification-reminders.ts`, `backend/tests/qualification-reminders.test.ts` |
| B7 | Nachweiszugriff mit Grund, Dokument-, Versions-, Mitarbeiter- und Objektbezug auditiert | `backend/src/routes/qualifications.ts`, `frontend/src/pages/EmployeeDetail.tsx` |
| B8 | Profil filtert DMS-Dokumente und entfernt Nachweismetadaten ohne wirksame `dms:read`-Berechtigung | `backend/src/routes/employees.ts`, `backend/tests/employee-profile.test.ts` |
| B9 | Freigabe prüft nur noch `available`-Version; Kundendokumentrechte in `request-review`/`return-for-revision` nachgezogen | `backend/src/routes/dms.ts`, `backend/tests/dms-approval.test.ts`, `backend/tests/dms-upload.test.ts` |
| B10 | Objektabdeckung auf zentrale Einsatzprüfung umgestellt; `requirement_count` korrigiert | `backend/src/routes/object-management.ts`, `backend/tests/object-coverage-eligibility.test.ts` |
| B11 | Neuer zentraler Helper `reevaluatePlannedAssignments()` in `staffing-verdict.ts`; wird bei Widerruf/Entfernung/Änderung einer Qualifikation, bei Beschäftigungsstatus-/Austrittsdatum-/Eintrittsdatumänderung und bei Objektanforderungswechseln im selben Transaction-Kontext aufgerufen. Harte Urteile erzeugen einen auditierbaren `schedule_conflicts`-Eintrag (`ineligible_assignment`, `severity='error'`, `details.source`, `details.trigger`, `details.reason_codes`); gültig gewordene Urteile lösen nur eigene Konflikte über `resolved_at` auf. Keine Löschung oder Statusänderung an Zuordnungen, keine Schemaänderung. | `backend/src/services/staffing-verdict.ts`, `backend/src/routes/qualifications.ts`, `backend/src/routes/employees.ts`, `backend/src/routes/scheduling.ts`, `backend/tests/planned-assignment-reevaluation.test.ts` |
| B12 | Statuslabels, archivierter Statusfilter, CSS-Klassen und Reason-Labels ergänzt | `frontend/src/lib/status.ts`, `frontend/src/pages/Employees.tsx`, `frontend/src/pages/Sites.tsx` |

Bestehende Architektur und funktionierende Funktionen wurden erhalten. Es wurden keine Attrappen eingebaut, keine Prüfungen deaktiviert und keine Migrationen an `001`–`064` verändert. `employee_qualifications` bleibt einzige Qualifikationsdatenquelle; Migration `065` bleibt additiv und mandantensicher.

## D Testergebnisse

| Kategorie | Ergebnis | Details |
|---|---|---|
| `npm run lint` | **Erfolgreich getestet** | Keine ESLint-Fehler. |
| `npm run typecheck` | **Erfolgreich getestet** | Backend und Frontend ohne TypeScript-Fehler. |
| `npm run build` | **Erfolgreich getestet** | Erfolgreich; nur bekannte Chunk-Größenwarnung (>500 kB). |
| Backend-Unit-/Integrationstests | **Erfolgreich getestet** | 66 Suites, 576 Tests, 0 Fehler mit Testdatenbank `securityops_qa_test`. Details siehe Abschlusslauf unten. |
| Frontend-Tests | **Erfolgreich getestet** | 14 Testdateien, 169 Tests, 0 Fehler; inklusive neuer Create-Payload-Prüfung. Details siehe Abschlusslauf unten. |
| Qualifikations-E2E | **Erfolgreich getestet** | 13/13 Tests nach Fixture-Neuaufbau. Details siehe Abschlusslauf unten. |
| Integrations-E2E A–F | **Erfolgreich getestet** | Neue Spec `e2e/integration-audit-operations.spec.ts`; 8/8 Tests mit aktiven DMS-Abhängigkeiten. Details siehe Abschlusslauf unten. |
| Negativtests RBAC/Mandantentrennung | **Erfolgreich getestet** | Unit-, Integrations- und Browser-API-Prüfungen: `403`/`404` wie erwartet. |
| Datenbankkonsistenz | **Teilweise getestet** | Abfragen im isolierten E2E-Tenant: keine doppelten Personalnummern, keine als `valid` markierten abgelaufenen Qualifikationen, keine künftigen Einsätze ausgeschiedener Mitarbeiter, keine Einsätze ohne Objekt, keine gelöschten Dokumente mit Zuordnung. Keine Produktionsabfrage. |
| Migration 065 | **Teilweise getestet** | Additive Migration im lokalen QA-Schema vorhanden; `max(version)=65`. Produktionsmigration nicht ausgeführt. |
| Produktionsumgebung | **Nicht getestet** | Kein Produktionszugang. |

### Regressionstests

Neue oder angepasste Tests decken insbesondere ab:

- direkte Zuweisung ohne Pflichtqualifikation → `409`, `reason_code=qualification_missing`, kein `INSERT`;
- Beschäftigungsbeginn/-ende in `staffing-eligibility.ts`;
- Freigabeentzug bei neuem DMS-Version-Upload inklusive Audit;
- Download/Preview einer gescannten, aber nicht freigegebenen Version → `409`;
- Ablehnung nicht verfügbarer Versionen bei der Freigabe;
- zentrale SQL-Klassifikation statt lokaler Substrings im Dashboard;
- `employee_history` mit vorher/nachher-Werten;
- Ausblenden von DMS-Metadaten ohne `dms:read`;
- konsistente aktive Beschäftigungsfilter in allen Erinnerungsabfragen.

### Abschlusslauf (27.11.2026)

| Prüfung | Kommando | Ergebnis |
|---|---|---|
| Lint, Typen, Build | `npm run lint && npm run typecheck && npm run build` | Erfolgreich; nur die bekannte Chunk-Größenwarnung >500 kB. |
| Backend gesamt | `POSTGRES_TEST_DATABASE_URL=postgres://securityops:securityops@localhost:5432/securityops_qa_test npm test -w backend -- --runInBand --silent` | 66 Suites / 576 Tests bestanden, 0 fehlgeschlagen. |
| Frontend gesamt | `npm test -w frontend -- --silent` | 14 Testdateien / 169 Tests bestanden, 0 fehlgeschlagen. Jsdom-Hinweise zu nicht implementierter Navigation traten auf, ohne Testdurchfall. |
| Qualifikations-E2E | `LOGIN_RATE_LIMIT_MAX=400 API_RATE_LIMIT_MAX=2000 npx playwright test e2e/qualification-management.spec.ts` | 13/13 bestanden. |
| Integrations-E2E A–F | `LOGIN_RATE_LIMIT_MAX=400 API_RATE_LIMIT_MAX=2000 npx playwright test e2e/integration-audit-operations.spec.ts` | 8/8 bestanden, einschließlich echtem DMS-Upload, Virenscan und Freigabe (keine Skip-Bedingung aktiv; `/ready/dms` = `200`). |

Vor dem finalen A–F-Lauf wurden MinIO und ClamAV aus dem lokalen Compose-Stack gestartet und der Backend-Prozess mit den passenden DMS-Zielwerten neu gestartet. Ein zwischenzeitlicher `HTTP 500` beim Anlegen von Testmitarbeitern war auf eine Kollision des generierten `employee_number` im E2E-Helfer zurückzuführen (Großbuchstaben wurden zu `_` normalisiert); nach der Normalisierung auf Kleinbuchstaben lief die Suite fehlerfrei. Es handelte sich nicht um eine fachliche Ablehnung der Anwendung.

## E Browserabnahme

Durchgeführt im laufenden Frontend `http://localhost:5173` gegen API `http://localhost:3000`.

| Prüfung | Ergebnis |
|---|---|
| Admin `e2e-qm-admin@example.invalid`: Navigation `/employees`, `/qualifications`, `/sites`, `/dms`, `/scheduling`, Mitarbeiterprofil | **Erfolgreich getestet**; keine Konsolenfehler. |
| Mitarbeiterübersicht zeigt konsistent „Widerrufen“ statt widersprüchlich „Abgelaufen“ / „Läuft bald ab“ | **Erfolgreich getestet**. |
| Operator `e2e-scale-20261126@example.invalid`: Navigation in denselben Bereichen | **Erfolgreich getestet**; keine Konsolenfehler. |
| RBAC: Qualifikationsneuzuweisung mit Operator ohne `qualifications:write` → `403` | **Erfolgreich getestet**. |
| Mandantentrennung: Mitarbeiterprofil aus fremdem Tenant → `404` | **Erfolgreich getestet**. |
| Einsatzprüfung: Leseweg und direkter Schreibweg liefern denselben Ablehnungsgrund (`qualification_expired`) | **Erfolgreich getestet**; `409` mit `reason_code`. |
| Sichtbare Aktionen für eingeschränkte Rollen | **Teilweise getestet**; Operator besitzt `dms:write`/`employees:write`, daher wurden diese Buttons bewusst zugelassen; eine Rolle ohne diese Rechte wurde nicht im Browser angemeldet. |
| Screenshot-Artefakte | **Erfolgreich getestet**; `docs/QA/screenshots/integrationsaudit-employees.png`, `integrationsaudit-qualifications.png`, `integrationsaudit-objects.png`, `integrationsaudit-dms.png`, `integrationsaudit-scheduling.png`; keine Konsolenfehler. |
| Mehrfach wiederholte Warnung „Schlüssel prüfen: E2E Verlustschlüssel“ | **Teilweise getestet**; fachlicher E2E-Alarm, kein Integrationsfehler der geprüften Kette. |

## F Offene Punkte

| Punkt | Status | Bewertung |
|---|---|---|
| Versions-Upload-Idempotenz (`client_mutation_id` wird noch nicht als DB-Constraint genutzt) | **Teilweise getestet** | Offen; benötigt additive Migration. Keine Produktionsänderung ohne Freigabe. |
| Archivieren/Löschen von DMS-Dokumenten über API | **Nicht getestet** | Offen; bestehende Status-/Aufbewahrungslogik unverändert. |
| `min_rest_minutes`, `required_staff_count`, Overnight-Availability/DST | **Teilweise getestet** | Bestehende Regelprofile unverändert; nicht Gegenstand dieser Korrektur. |
| History-Löschung per CASCADE bei physischer Mitarbeiterlöschung | **Teilweise getestet** | API-Löschweg entfernt; DB-CASCADE bleibt unverändert, um Produktionsdaten nicht zu gefährden. |
| UI zeigt einzelne Aktionen ohne Rechte (Objektverwaltung) | **Teilweise getestet** | Nicht vollständig bereinigt; keine funktionale Umgehung, aber UX-Risiko. |
| Dashboard-KPI „Qualifikationswarnungen“ mischt fachliche Zustände | **Teilweise getestet** | Zählung nun konsistent zur zentralen Klassifikation; Differenzierung nach Schweregrad bleibt offen. |
| Produktionsprüfung, Produktionsdatenabgleich, Produktionsmigration | **Nicht getestet** | Kein Produktionszugang; ausdrücklich nicht durchgeführt. |

## G Deployment

### Vorbereitete Checkliste

1. **Backup:** Vollbackup der Produktionsdatenbank und des DMS-Objektspeichers erstellen; Backup-Pfad und Wiederherstellungstest protokollieren.
2. **Zielumgebungsprüfung:** Version, Migrationsstand `max(version)=65`, Checksums `001`–`064`, DMS-Storage, Virenscanner, Queue, Frontend-Build und Rollen-/Mandantenkonfiguration prüfen.
3. **Migration 065:** `065_qualification_recertification_history.sql` additiv anwenden; keine existing Checksums ändern; Ergebnis und Dauer protokollieren.
4. **Migrationsergebnis:** `max(version)=65`, saubere `schema_migrations`-Zeile, keine doppelten aktuellen Qualifikationszuordnungen, RLS weiterhin erzwungen.
5. **Backend-Deployment:** neue Artefakte aus diesem Branch ausrollen; Health/Ready/DMS-Ready prüfen; keine generierenden Runner-Dateien oder Headers überschreiben.
6. **Frontend-Deployment:** gebautes Artefakt aus `npm run build` ausrollen; Statuslabels und Nachweisdialog prüfen.
7. **Funktionstest:** Szenarien A–F, Negativtests RBAC/Mandantentrennung, DMS-Freigabe und direkte Assignment-Ablehnung in der Zielumgebung wiederholen.
8. **Rollback/Wiederherstellung:** Backend/Frontend auf vorherige Version zurücksetzen; Datenbank nur über geprüftes Backup wiederherstellen; keine destruktive Down-Migration ohne Freigabe.

### Status

Die Checkliste ist vorbereitet. Die Ausführung in Produktion ist **nicht durchgeführt**.

## H Gesamtfreigabe

**Freigabe für QA/Staging: erteilt.**  
**Freigabe für Produktion: nicht erteilt** — Produktionsprüfungen und -migrationen wurden ohne Zugang nicht durchgeführt.

Die fachliche Kette ist in der lokalen/QA-Umgebung durch Unit-, Integrations-, E2E- und Browserprüfungen abgesichert. Vor einer Produktionsfreigabe müssen Backup, Zielumgebungsprüfung, Migration 065, Funktionstest und Rollbackprobe in der Produktionsumgebung unter dokumentierter Freigabe nachgeholt werden.
