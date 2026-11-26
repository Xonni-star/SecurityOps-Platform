# Sprachliche Überarbeitung – SecurityOps-Platform

Stand: 2026-11-26 · Branch: `fix/employee-master-data-save` · Ausgangsstand: `41d03a6` (Basis des Sprachzweigs: `9e924a1`)

## Ziel und Vorgehen

Die gesamte Oberfläche wurde auf durchgängiges, professionelles Deutsch umgestellt. Dabei wurden Navigation, Überschriften, Beschreibungen, Kennzahlen, Tabellen, Formulare, Platzhalter, Meldungen, Dialoge, Leer- und Ladezustände sowie benutzersichtbare Backend-Antworten geprüft.

Es wurde **kein paralleles i18n-System** eingeführt. Stattdessen wurden drei zentrale Module als einzige Quelle für wiederkehrende Texte und Formate geschaffen und von allen Seiten genutzt:

| Modul | Zweck |
|---|---|
| `frontend/src/lib/format.ts` | De-DE-Formatierung für Datum, Uhrzeit, Zahlen und EUR; Zeitzone `Europe/Berlin`; Umrechnung lokaler Formulareingaben in UTC. |
| `frontend/src/lib/status.ts` | Kontextabhängige deutsche Bezeichnungen für Status, Rollen, Prioritäten, Risiken, Kanäle, Dokumentkategorien, Sensoren und Bewegungen. |
| `frontend/src/lib/text.ts` | Wiederverwendbare Beschriftungen, Standardmeldungen und Hilfsfunktionen für Pflichtangaben. |

Technische Enums, API-Feldnamen, HTTP-Statuscodes, Error-Codes, Datenbankspalten und gespeicherte Datenwerte blieben unverändert. Die Übersetzung erfolgt ausschließlich in der Darstellung bzw. in benutzersichtbaren Antworttexten.

## Geprüfte Module

### Frontend

- Leitstelle: Übersicht, Live-Karte, Alarme, Einsätze, Kontrollgänge
- Betrieb: Mobile Einsatz-App, Wachbuch, Dienstplanung, Schichtübergaben, Nachrichten
- Verwaltung: Mitarbeiter, Mitarbeiterdetail, Kunden, Kundendetail, Objekte, Geräte, Schlüssel, Schlüsseldetail, Schlüsselbünde, NFC-Geräte, Qualifikationen
- Dokumente & Auswertungen: Dokumente, Auswertungen, Kundenberichte
- System: Benachrichtigungen, Sensoren, Alarmweiterleitung, Kontosicherheit, Administration
- Anmeldung, MFA und Passwort-Wiederherstellung
- Navigation, Seitentitel, Beschreibungen, `index.html` und Web-App-Manifest

### Backend

- Zentrale Fehler- und Authentifizierungsmiddleware
- Authentifizierung, MFA, Geräte- und Sitzungsverwaltung
- Alle benutzersichtbaren Meldungen in `backend/src/routes/**` und `backend/src/services/**`
- Provider-Statusmeldungen für SMTP, SMS und TimeScan
- OpenAPI-Antwortbeschreibungen, soweit benutzersichtbar

## Überarbeitete Textbereiche

| Bereich | Wesentliche Änderungen |
|---|---|
| Navigation und Seitenkopf | Einheitliche Titel, Gruppen und aussagekräftige Beschreibungen für alle 25 Hauptrouten. „Wächter-App“ → „Mobile Einsatz-App“, „Bunde“ → „Schlüsselbünde“. |
| Anmeldung / Kontosicherheit | Klare Feldbezeichnungen, deutsche Platzhalter, verständliche MFA- und Passwortmeldungen. |
| Mitarbeiter und Details | Statusbegriffe, Datum-/Zahlenformate, Qualifikationsstatus, Beschäftigungsarten und UUID-Validierung zentralisiert. |
| Kunden und Kundendetail | Filter „Status: Alle“ / „Vertragsstatus: Alle“ / „Aktivitätsstatus: Alle“, CSV-Export, Risiko- und Prioritätslabels. |
| Objekte | Rohstatuswerte, Datumsformate und Dokumentbegriffe auf zentrale Helfer umgestellt; „Version“ → „Fassung“, „Kenntnisnahmen“ → „Bestätigungen“. |
| Schlüsselverwaltung | „Export“ → „CSV exportieren“, „+ Bund anlegen“ → „Schlüsselbund anlegen“, „QR/Etikett“ → „QR-Code & Etikett“, Bewegungs- und Verluststatus deutsch. |
| Mobile Einsatz-App | „PANIK“ → „Panik-Alarm auslösen“, „Offline-Outbox“ → „Offline-Warteschlange“, deutsche Offline- und Sync-Meldungen. |
| Administration | „Host“ → „Hostname“, „Port“ → „Portnummer“, „Bucket“ → „Bucketname“, deutsche Begründungs- und Fehlertexte. |
| DMS, Berichte, Planung, Wachbuch, Alarmweiterleitung | Einheitliche Überschriften, Beschreibungen, Formularlabels, Platzhalter und Leerzustände. |
| Backend-Meldungen | `Not found` → `Nicht gefunden`, `Invalid request` → `Ungültige Anfrage`, `Internal server error` → `Interner Serverfehler`, `Authentication required` → `Anmeldung erforderlich`, `Invalid credentials` → `Ungültige Anmeldedaten`, Provider- und Gerätemeldungen deutsch. |

## Vereinheitlichte Begriffe

| Begriff | Bisherige Varianten | Verwendung |
|---|---|---|
| Aktiv / Inaktiv | active, inactive, enabled, disabled | Geräte, Objekte, Kunden, Benutzerkonten |
| Ausstehend | pending, pending_approval | Freigaben, Anträge, Bestätigungen |
| Beantragt / Genehmigt / Abgelehnt | requested, approved, rejected | Freigabe- und Antragsprozesse |
| In Bearbeitung | in_progress, mitigating | Alarme, Gefährdungen, Maßnahmen |
| Erledigt | resolved (Alarm) | Alarmabschluss |
| Abgeschlossen | completed, closed | Einsätze, Aufgaben, Maßnahmen |
| Überfällig | overdue | Schlüssel, Fristen |
| Nicht zugewiesen | unassigned, not_assigned, null | Zuordnungen, Halter, Verantwortliche |
| Nicht verfügbar | unavailable, null in bestimmten Domänen | Geräte, Dokumente, Datensätze |
| Zugewiesen / Halter | assigned, holder | Schlüssel und Personalzuordnung |
| Bestätigung / quittiert | acknowledgement, acknowledged | Übergaben, Anweisungen, Alarme |
| Fassung | Version | DMS, Anweisungen, Wachbucheinträge |
| Objekt | Standort, site, Gebäude | Betreutes Kundenobjekt; Standort bleibt nur für geografische Zuordnung |
| Schlüsselbund | Bund | Schlüsselverwaltung |
| Risikowert | Risikoscore, Risk score | Gefährdungen und Risikomatrix |
| CSV exportieren | Export | Alle Export-Buttons |
| Panik-Alarm | PANIK | Mobile Einsatz-App |
| Offline-Warteschlange | Offline-Outbox | Mobile Einsatz-App |
| Mobile Einsatz-App | Wächter-App, Mobile Guard | Navigation, Manifest, Tests |

Rollen, Prioritäten und Risiken werden ebenfalls zentral übersetzt, u. a. `admin` → `Administrator`, `superadmin` → `Systemadministrator`, `operator` → `Disponent`, `viewer` → `Betrachter`, `critical` → `Kritisch`, `unknown` → `Nicht bewertet`.

## Neue und geänderte Beschreibungen

Die Beschreibungen in `frontend/src/components/Layout.tsx` wurden vollständig überarbeitet und beschreiben genau die vorhandenen Funktionen:

| Route | Beschreibung |
|---|---|
| `/` | Zentrale Übersicht über die aktuelle Sicherheitslage, offene Vorgänge und operative Kennzahlen. |
| `/map` | Aktuelle Positionen und Standorte der eingesetzten Geräte im Überblick. |
| `/alarms` | Alarme prüfen, priorisieren, übernehmen und revisionssicher bearbeiten. |
| `/incidents` | Einsätze und Ereignisse dokumentieren, verfolgen und abschließen. |
| `/patrols` | Kontrollgänge, Kontrollpunkte und Abweichungen im Überblick. |
| `/mobile` | Mobile Leitstellenfunktionen für den Einsatz vor Ort. |
| `/watchbook` | Wachbucheinträge nachvollziehbar erfassen, korrigieren und schließen. |
| `/scheduling` | Dienstpläne, Schichten und Besetzungen für den operativen Alltag verwalten. |
| `/handovers` | Schichtübergaben strukturiert dokumentieren und bestätigen. |
| `/messages` | Interne Nachrichten und wichtige Informationen sicher austauschen. |
| `/employees` | Mitarbeiter, Kontaktdaten und operative Zuordnungen verwalten. |
| `/customers` | Kundenstammdaten und Ansprechpartner zentral pflegen. |
| `/sites` | Objekte, Adressen und sicherheitsrelevante Standortdaten verwalten. |
| `/devices` | Betriebsgeräte, ihre Zuordnungen und ihren Status verwalten. |
| `/keys` | Schlüssel, Schlüsselbünde, Ausgaben, Verlustmeldungen und Bestandskontrollen verwalten. |
| `/nfc-devices` | NFC-Geräte registrieren, zuordnen und bei Bedarf sperren. |
| `/qualifications` | Qualifikationen und Gültigkeiten von Mitarbeitern verwalten. |
| `/dms` | Sicherheitsrelevante Dokumente in Fassungen und revisionssicher verwalten. |
| `/reports` | Kennzahlen, Arbeitszeiten und exportierbare Berichte für Auswertung und Nachweis. |
| `/customer-reports` | Berichte für Kunden erstellen und kontrolliert bereitstellen. |
| `/notifications` | Benachrichtigungen und persönliche Zustellungen im Blick behalten. |
| `/telemetry` | Sensorwerte und Schwellenwerte zur technischen Überwachung auswerten. |
| `/alarm-forwarding` | Alarmweiterleitungen und Eskalationsregeln für externe Ziele konfigurieren. |
| `/account-security` | Zwei-Faktor-Authentifizierung, Sitzungen und Sicherheitsoptionen des eigenen Kontos verwalten. |
| `/admin` | Systemweite Einstellungen, Backups, Integrationen und Audit-Nachweise verwalten. |

Zusätzlich wurden die Einleitungstexte der Fachmodule überarbeitet, etwa für Kontrollgänge („Legen Sie Kontrollstellen mit ihrer Reihenfolge und NFC-Kennung für die Kontrollgänge an.“), Sensoren („Überwachen Sie Sensorwerte und die konfigurierten Schwellenwerte der technischen Ausstattung.“) und Dokumente.

## Formulare und Meldungen

- Pflichtfelder erhalten eindeutige Bezeichnungen und erklärende Platzhalter, z. B. „Kennung des NFC-Tags“, „Kennung des Benutzerkontos“, „Grund für die Änderung“.
- Fehlermeldungen enthalten Korrekturhinweise, z. B. `Bitte eine gültige Benutzerkennung angeben.` und `Die Daten konnten nicht gespeichert werden. Bitte prüfen Sie Ihre Eingaben.`
- Datum und Uhrzeit werden als `TT.MM.JJJJ` bzw. 24-Stunden-Zeit in `Europe/Berlin` angezeigt.
- Zahlen verwenden Komma als Dezimal- und Punkt als Tausendertrennzeichen; Währungen werden als EUR formatiert.
- Formulareingaben werden aus `Europe/Berlin` in UTC umgerechnet; technische Speicherformate bleiben unverändert.
- Verweise auf Nachweise erhalten unterscheidbare Bezeichnungen („Qualifikationsnachweis öffnen", „Dienstanweisung öffnen", „Personaldaten öffnen"), damit sie auch mit Screenreadern eindeutig sind.

## Verbleibende englische Begriffe

| Begriff | Begründung |
|---|---|
| SecurityOps | Produktname, nicht übersetzbar. |
| MFA, TOTP, CSRF | Etablierte Sicherheits- und Protokollbegriffe; auch in Meldungen und Konfiguration üblich. |
| SMTP, SMS, TimeScan, Webhook, NFC, QR, In-App | Etablierte Produkt-, Protokoll- und Standardbegriffe. |
| Authenticator-App | Marken-/Gattungsbegriff für TOTP-Apps. |
| Idempotency-Key | Technischer Header-Name; API-Vertrag. |
| Health-Check, Secret, Bucket, Hostname, URL, API, JSON, CSV, PDF, UUID | Etablierte IT-Fachbegriffe bzw. technische Bezeichnungen. |
| `smtp`, `sms`, `timescan`, `in_app`, `webhook` und weitere Enum-Werte | Interne Enums/API-Werte; werden nur in der Anzeige übersetzt. |
| Interne Log- und Konfigurationsmeldungen | Nicht benutzersichtbar; aus Gründen der Diagnose und Vertragstreue unverändert. |
| `Ava Worker`, `Authenticated device` und weitere Testdaten | Bestehende Demo-/Fixture-Daten; keine UI-Beschriftungen und nicht Teil der Sprachänderung. |

## Nicht prüfbare Bereiche

- Live-Zustellung über echte SMTP-, SMS-, Webhook- und TimeScan-Instanzen ohne Produktionszugang; geprüft wurden Konfigurationsoberfläche, Statusmeldungen und Fehlerpfade.
- Native Android-App zur Laufzeit; geprüft wurde die Web-App inklusive Manifest und Service Worker.
- Rollen-/Rechtematrix wurde über die vorhandenen Testkonten und Berechtigungsprüfungen im Code und in Tests bewertet, nicht für jede denkbare Kombination live durchgespielt.
- Bestehende Datenbankwerte, Enums und API-Verträge wurden bewusst nicht verändert; die Dokumentation der Risiken R-001 bis R-013 in `docs/QA/FEHLERANALYSE.md` bleibt davon unberührt.

## QA-Nachweis

| Prüfung | Vorgehen | Ergebnis |
|---|---|---|
| TypeScript-Typecheck | `npm run typecheck` | Erfolgreich für Backend und Frontend. |
| Linter | `npm run lint` | Keine Fehler oder Warnungen. |
| Frontend-Tests | `npm test -w frontend -- --run` | 11 Testdateien, 101 Tests bestanden. |
| Backend-Tests | `POSTGRES_TEST_DATABASE_URL=… LOG_LEVEL=silent npm test -w backend -- --runInBand` | 53 Suites, 366 Tests bestanden, einschließlich PostgreSQL-Integrationstests. |
| Build | `npm run build` | Backend- und Frontend-Build erfolgreich; Vite-Produktionsbundle erstellt. |
| Playwright-Strukturprüfung | `npx playwright test --list` | 13 Tests in 6 Dateien laden fehlerfrei. |
| Playwright-Suite | `npm run e2e` mit lokalen Fixture-Zugangsdaten | 13 Tests in 6 Dateien bestanden. Dabei wurden zwei veraltete Erwartungen korrigiert: „Risiko 12" → „Risikowert 12" und die zu unspezifische Linkbezeichnung durch eine zielbezogene Lokatorprüfung ersetzt. |
| Browserprüfung | 25 Hauptrouten in drei Viewports (1440 × 900, 820 × 1000, 390 × 844 px), angemeldet | 75 Routenaufrufe ohne Navigationsfehler, ohne JavaScript-Konsolenfehler und ohne HTTP-Antworten ≥ 400. |
| Layout und Textumbruch | Prüfung von `document.documentElement.scrollWidth` je Route und Viewport | Kein horizontaler Überlauf mehr; zuvor auffällige Seiten (`/sites`, `/customers`) sind korrigiert. |
| Formulare und Buttons | Stichproben im Browser, ergänzt durch Komponententests | Dialog „Schlüssel anlegen“ mit deutschen Feldbezeichnungen geöffnet und geschlossen; Filter, Export, Status- und Bewegungsaktionen durch Tests abgedeckt. |
| API- und Datenbankverträge | Backend-Integrationstests, OpenAPI-Coverage-Tests, unveränderte Enums und Spalten | Bestätigt; Statuscodes, Feldnamen, Enum-Werte und gespeicherte Datenwerte blieben unverändert. |

Die systematische Suche nach englischen Resttexten in `frontend/src` und `backend/src` sowie die Sichtbarkeitsprüfung im Browser ergaben keine übersetzungsbedürftigen Oberflächentexte. Der verbleibende Treffer „Panik“ ist Teil der korrekten deutschen Begriffe „Panik-Alarm“ und „Panikalarm“.

## Geänderte Dateien

Zentrale neue Text-/Formatmodule: `frontend/src/lib/format.ts`, `frontend/src/lib/status.ts`, `frontend/src/lib/text.ts`.

Überarbeitete Frontend-Oberfläche: `frontend/index.html`, `frontend/public/manifest.webmanifest`, `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx`, `frontend/src/lib/api.ts`, `frontend/src/polish.css` und alle Seiten unter `frontend/src/pages/**` (AccountSecurity, Admin, AlarmForwarding, CustomerDetail, CustomerReports, Customers, Dms, EmployeeDetail, Employees, Handovers, Incidents, KeyDetail, Keys, LiveMap, Login, Messages, MobileGuard, NfcDevices, Notifications, NslDashboard, Operations, Patrols, Qualifications, Reports, Resource, Scheduling, Sites, Telemetry, Watchbook, keyParts).

Benutzersichtbare Backend-Texte: `backend/src/middleware/**`, `backend/src/openapi.ts`, `backend/src/routes/**` und `backend/src/services/**`.

Angepasste Tests: `frontend/tests/**`, `backend/tests/**` und `e2e/**`.

<details>
<summary>Vollständige Liste der geänderten und neuen Dateien</summary>

```text
backend/src/middleware/auth.ts
backend/src/middleware/errors.ts
backend/src/openapi.ts
backend/src/routes/alarm-forwarding.ts
backend/src/routes/auth.ts
backend/src/routes/backups.ts
backend/src/routes/crud.ts
backend/src/routes/customer-reports.ts
backend/src/routes/customers.ts
backend/src/routes/dms.ts
backend/src/routes/employees.ts
backend/src/routes/handovers.ts
backend/src/routes/keys.ts
backend/src/routes/maintenance.ts
backend/src/routes/object-chronicle.ts
backend/src/routes/object-management.ts
backend/src/routes/phase2.ts
backend/src/routes/phase3.ts
backend/src/routes/phase4.ts
backend/src/routes/phase5.ts
backend/src/routes/phase6.ts
backend/src/routes/phase8.ts
backend/src/routes/qualifications.ts
backend/src/routes/scheduling.ts
backend/src/routes/staffing.ts
backend/src/routes/watchbook.ts
backend/src/services/auth.ts
backend/src/services/backup-adapters.ts
backend/src/services/backup-domain.ts
backend/src/services/backup.ts
backend/src/services/devices.ts
backend/src/services/dms-domain.ts
backend/src/services/dms-providers.ts
backend/src/services/external-forwarding.ts
backend/src/services/keys-domain.ts
backend/src/services/mfa.ts
backend/src/services/notifications.ts
backend/src/services/provider-status.ts
backend/src/services/secrets.ts
backend/src/services/timescan.ts
backend/src/services/worker-lease.ts
backend/tests/customers.test.ts
backend/tests/dms.test.ts
backend/tests/employee-profile.test.ts
backend/tests/keys.test.ts
backend/tests/object-management.test.ts
backend/tests/openapi-coverage.test.ts
backend/tests/phase5.test.ts
backend/tests/secrets.test.ts
backend/tests/security.test.ts
backend/tests/sftp-adapters.test.ts
docs/QA/SPRACHUEBERARBEITUNG.md
e2e/customer-cockpit.spec.ts
e2e/key-management.spec.ts
e2e/leitstelle.spec.ts
e2e/object-management.spec.ts
e2e/phase4.spec.ts
frontend/index.html
frontend/public/manifest.webmanifest
frontend/src/App.tsx
frontend/src/components/Layout.tsx
frontend/src/lib/api.ts
frontend/src/lib/format.ts
frontend/src/lib/status.ts
frontend/src/lib/text.ts
frontend/src/pages/AccountSecurity.tsx
frontend/src/pages/Admin.tsx
frontend/src/pages/AlarmForwarding.tsx
frontend/src/pages/CustomerDetail.tsx
frontend/src/pages/CustomerReports.tsx
frontend/src/pages/Customers.tsx
frontend/src/pages/Dms.tsx
frontend/src/pages/EmployeeDetail.tsx
frontend/src/pages/Employees.tsx
frontend/src/pages/Handovers.tsx
frontend/src/pages/Incidents.tsx
frontend/src/pages/KeyDetail.tsx
frontend/src/pages/Keys.tsx
frontend/src/pages/LiveMap.tsx
frontend/src/pages/Login.tsx
frontend/src/pages/Messages.tsx
frontend/src/pages/MobileGuard.tsx
frontend/src/pages/NfcDevices.tsx
frontend/src/pages/Notifications.tsx
frontend/src/pages/NslDashboard.tsx
frontend/src/pages/Operations.tsx
frontend/src/pages/Patrols.tsx
frontend/src/pages/Qualifications.tsx
frontend/src/pages/Reports.tsx
frontend/src/pages/Resource.tsx
frontend/src/pages/Scheduling.tsx
frontend/src/pages/Sites.tsx
frontend/src/pages/Telemetry.tsx
frontend/src/pages/Watchbook.tsx
frontend/src/pages/keyParts.tsx
frontend/src/polish.css
frontend/tests/app.test.tsx
frontend/tests/customers.test.tsx
frontend/tests/form-contracts.test.tsx
frontend/tests/key-detail.test.tsx
frontend/tests/keys.test.tsx
frontend/tests/mobile.test.tsx
frontend/tests/sites.test.tsx
frontend/tests/text-formatting.test.ts
```

</details>
