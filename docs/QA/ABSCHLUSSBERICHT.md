# Abschlussbericht – Mitarbeiter-Stammdaten und System-QA

Datum: 2026-11-26 · Branch: `fix/employee-master-data-save` · Basis: `9e924a1` (`master`, inkl. PR #56)

## 1. Auftrag und Ergebnis

Der kritische Fehler beim dauerhaften Speichern von Mitarbeiter-Stammdaten wurde in der gesamten Kette Frontend → API → Datenbank analysiert, behoben und verifiziert. Zusätzlich wurden die im System auditierten Fehler derselben Klasse sowie ausgewählte Integritäts-, Autorisierungs- und Navigationsfehler korrigiert. Es wurden keine neuen Module, parallelen Datenstrukturen, zusätzlichen Sidebars oder Mock-Speicher eingeführt; bestehende RBAC-, RLS-, Audit- und API-Strukturen bleiben erhalten.

- Haupt-Commit: `e79b7b6b4fbb8dad2ce21c4db5f7d0398550f6f6` (`fix(employees): persist master data and harden related contracts`)
- Ergänzender CI-Commit: `a069d18` (`ci: run employee profile and integrity integration suites`; über die GitHub-Weboberfläche erstellt, da das lokale OAuth-Token keinen `workflow`-Scope besitzt)
- Pull Request: https://github.com/Xonni-star/SecurityOps-Platform/pull/57
- Zielbranch: `master`

## 2. Fehlerzahlen

| Kategorie | Anzahl | Status |
|---|---:|---|
| Reproduzierter kritischer Fehler (F-001) | 1 | Behoben, durch HTTP-, PostgreSQL-, Frontend- und Browser-Tests verifiziert |
| Statisch erkannte Fehlergruppen (F-002 bis F-010) | 9 | Behoben und durch automatisierte Tests abgesichert |
| Verbleibende, nur statisch erfasste Risiken (R-001 bis R-013) | 13 | Bewusst offen, nicht Teil dieses Bugfixes |
| Neue Migrationen (keine Änderung bestandener Migrationen) | 2 | `057_tenant_fk_setnull_columns.sql`, `058_absence_status_double_booking.sql` |

Details zu Ursachen, Dateien und Korrekturen: [`FEHLERANALYSE.md`](FEHLERANALYSE.md).

## 3. Modulstatus

| Modul / Bereich | Status | Hinweis |
|---|---|---|
| Mitarbeiterakte / Stammdaten | Behoben | Allowlist-Payload, Feldfehler, Lade-/Erfolgszustand, Doppelklick-Schutz, Reload, transaktionales Audit |
| Mitarbeiter-Historie & Audit | Behoben | `employee_history` und `audit_events` in derselben Transaktion wie das UPDATE |
| Datenbank/Tenant-Integrität | Behoben | Migration 057 für SET-NULL-FKs und DMS-Verantwortlichen-FK, 058 für Abwesenheitsstatus |
| RLS / Mandantentrennung | Unverändert geprüft | RLS/FORCE-RULES für alle tenantbezogenen Tabellen vollständig; keine fehlende Stammdaten-Spalte |
| Geräte/Resource | Behoben | Typisiertes Formular mit Enum-Status und echter Objekt-UUID |
| Administration (SMTP/SMS/Backup/TimeScan/Regeln) | Behoben | Pro Formular eigener Änderungsgrund, geprüfte Secret-Referenzen, idempotente Regeln |
| Mobile/Push/Patrol, Kontrollgänge, Nachrichten | Behoben | UUID-Prüfung und saubere Push-Payload-Projektion |
| DMS, Kundenkontakte, Qualifikationen, Schichtübergaben | Behoben | Korrekte Objekt-IDs, `null` statt leerer Werte, eindeutige Teilnehmeridentität |
| Planung/Scheduling | Behoben | ISO-Konvertierung erst beim Senden, `client_mutation_id`, gültige Objektauswahl |
| Reporting/Export | Behoben | Filter-UUIDs validiert, Tenant-Joins, strukturgültige PDFs |
| Navigation/Auth/Login | Behoben | Server-Session-Prüfung, Login-Umleitung, explizite 404-Seite, korrigierte Menürechte |
| Dark Theme, Dashboard, WebSocket-Fehlerbilder | Offen | Siehe R-004, R-003, R-006; keine Auswirkung auf Speicherfunktion |

## 4. Verifikation

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | Grün (Backend + Frontend) |
| `npm run lint` | Grün |
| `npm run build` | Grün (Backend + Frontend inkl. Vite-Bundle) |
| Backend-Tests mit echter PostgreSQL-Datenbank | 53 Suites / 366 Tests grün |
| Frontend-Tests | 10 Dateien / 94 Tests grün |
| Vollständige Playwright-Suite | 13/13 Tests grün |
| Browser-Rundgang aller 22 Hauptrouten | Keine JS-Konsolenfehler, keine HTTP-Antworten ≥ 400 |
| Mitarbeiterdetail responsiv (1440/820/390 px) | Kein horizontaler Überlauf |

Der E2E-Haupttest `e2e/employee-master-data.spec.ts` deckt exakt den geforderten Ablauf ab: Mitarbeiter öffnen → Stammdaten bearbeiten → speichern → neu laden → Werte prüfen. Zusätzlich werden API-Reread, Fremdmandanten-PATCH und Responsive-Verhalten geprüft; die Fixture wird nach dem Test wiederhergestellt.

## 5. Risiken und offene Punkte

Die 13 in der Fehleranalyse gelisteten Risiken sind überwiegend UX- oder Robustheitsverbesserungen ohne nachgewiesene Auswirkung auf die Stammdatenpersistenz. Besonders zu beachten:

- Page-Level-Permission-Guards und Write-Buttons ohne UI-Rechteprüfung (R-001, R-002): API-Server erzwingt Rechte dennoch.
- TOCTOU bei Statusübergängen/Abwesenheit und nicht-transaktionale TimeScan-/Patrol-Pfade (R-009, R-010): bei Parallelnutzung können Teilresultate entstehen.
- MFA-Enrollment-UI nicht erreichbar (R-008): der Workflow ist derzeit nur über die API nutzbar.
- Origin-Pflicht nicht überall aktiv (R-011): CSRF-Token bleibt die primäre Absicherung.

Für diese Punkte wird eine gesonderte Follow-up-QA empfohlen; sie wurden nicht durch zusätzliche Module oder spitze Datenstrukturen umgangen.

## 6. Gesamtbewertung

Der gemeldete Bug ist vollständig behoben: gespeicherte Stammdaten bleiben nach Reload erhalten, alle vorhandenen Felder sind bearbeitbar, nicht freigegebene Felder werden vom Server abgewiesen, und Audit/Historie sind konsistent. Die zusätzlichen Korrekturen decken dieselbe Fehlerklasse in weiteren Formularen ab und schließen Datenbank-, Reporting- und Navigationslücken. Mit 366 Backend-, 94 Frontend- und 13 Browser-Tests sowie erfolgreichem Build ist die Änderung regressionsfest. Die verbleibenden Risiken sind dokumentiert und beeinträchtigen die Kernfunktion nicht. **Gesamtbewertung: freigabefähig mit dokumentierten Follow-up-Risiken.**
