# Abschlussbericht – Kundenberichtswesen (Phasen 1–15)

Datum: 2026-11-28 · Branch: `feature/kundenberichte-professionalisierung` · Basis: `origin/master` / `daa3456`

## 1. Auftrag und Ergebnis

Das Kundenberichtswesen wurde auf einem eigenen Branch vollständig professionalisiert. Freigegebene Berichte sind unveränderliche Schnappschüsse mit gespeicherter Zeilenbasis und SHA-256-Fingerprint; das Kundenportal liest ausschließlich freigegebene eigene Daten und bietet keine Exportaktion. Freigaben erfolgen nach Vier-Augen-Prinzip aus dem Status `in_review` durch eine andere Person, Widerruf und Ablehnung benötigen eine Begründung. Alle sichtbaren Texte sind deutsch. Es wurden keine parallelen Datenstrukturen, keine zweite Datenbank, keine doppelte Fachlogik und keine Beispieldaten in produktiven Auswertungen eingeführt. `iptv-android/` blieb unangetastet.

- Commit: `feat(kundenberichte): snapshots, four-eyes approval and read-only portal` (finaler Commit auf dem Branch, siehe Pull Request)
- Pull Request: https://github.com/Xonni-star/SecurityOps-Platform/pull/71 (Zielbranch `master`, kein direkter Merge)
- QA-Befund: [`screenshots/customer-reports-browser-acceptance.json`](screenshots/customer-reports-browser-acceptance.json)

## 2. Phasen 1–15

| Phase | Gegenstand | Ergebnis / Nachweis |
|---|---|---|
| 1 | Bestandsaufnahme und Abgrenzung zum Reporting-Zentrum | Bestehende Legacy-Route, RBAC-Keys, Audit, Migrationen und OpenAPI geprüft; `reporting-domain.ts` des Reporting-Zentrums bleibt nicht Teil dieser Branch-Basis, neuer zentraler SQL-Vertrag `customer-report-domain.ts` |
| 2 | Anforderungs- und Rechteklärung | `customer_reports:read/write/approve/export` und `customer_portal:read` als getrennte Rechte; `customer_portal:read` impliziert niemals Exportberechtigung |
| 3 | Datenmodell und Migration | `069_customer_reports_professionalisierung.sql` mit `customer_report_releases`, RLS, Indizes und Permission-Grants; nur Snapshot-Metadaten und Zeilenbasis, keine Freitexte oder Mitarbeiterdaten |
| 4 | Domain-Service und Zeitvertrag | `backend/src/services/customer-report-domain.ts`: Berliner Tagesgrenzen, Filter, Sortierung, Projektion, Fingerprint, CSV-/Text-/PDF-Zeilen; keine Mock-Kennzahlen |
| 5 | Vorschau echter Fachdaten | `GET /customer-reports/preview/:kind` mit Mandanten-, Objekt- und Kundenfilter; Audit und 403 bei fehlendem Objektzugriff |
| 6 | Entwurf mit Datenbasis | `POST /customer-reports/releases` speichert Filter, Zeilen, `row_count` und Fingerprint atomar in derselben Transaktion wie das Audit |
| 7 | Einreichung und Vier-Augen-Freigabe | `submit` nur aus `draft`, `approve` nur aus `in_review` und nur durch eine andere Person; geprüfter Fingerprint, ausgeführte Preview, gespeicherte Zeilen |
| 8 | Ablehnung und Widerruf | `reject`/`revoke` mit Pflichtbegründung; Widerruf entzieht dem Portal sofort den Zugriff (Detail HTTP 404) |
| 9 | Export und Export-Audit | CSV, PDF und XLSX nur für `approved` mit `customer_reports:export`; `x-report-row-count`, Audit `customer_report.exported`; PDF-Mehrzeilen mit korrektem XREF und maskierten Sonderzeichen |
| 10 | Kundenportal | `/customer-portal/releases` und `/:id` liefern `read_only:true`, `export_allowed:false` und nur freigegebene Snapshots; Legacy-Portal ohne Snapshot HTTP 404 statt Live-Daten |
| 11 | Legacy-Route und OpenAPI | `backend/src/routes/customer-reports.ts` additiv auf freigegebene Snapshots und kanonisches PDF umgestellt; neue Endpunkte in `backend/src/openapi.ts` dokumentiert, router vor Legacy-Route registriert |
| 12 | Frontend-Arbeitsbereich | `frontend/src/pages/CustomerReports.tsx` mit drei Bereichen: Bericht erstellen, Entwürfe und Freigaben, Kundenportal; Rollen-/rechteabhängige Aktionen, Vorschau, Details, Freigabe, Widerruf und Exporte |
| 13 | Einbettung in bestehende Oberfläche | Navigation, Kunden-, Objekt- und Detailseiten verlinkt; keine zweite Sidebar, keine parallele Navigation |
| 14 | Automatisierte Tests | Backend 61 Suites / 597 Tests grün, Frontend 17 Dateien / 187 Tests grün, E2E 1/1 grün, Typecheck/Lint/Build grün |
| 15 | Browserabnahme und Dokumentation | Admin/Operator/Viewer auf Desktop und Tablet geprüft; Screenshots und QA-JSON unter `docs/QA/screenshots/`; Abschlussbericht, Commit, Push und PR |

## 3. Verifikation

| Prüfung | Ergebnis |
|---|---|
| `npm test -w backend -- --runInBand` | 61 Suites / 597 Tests grün (10 Suites / 62 Tests übersprungen) |
| `npm test -w frontend` | 17 Dateien / 187 Tests grün |
| `E2E_FIXTURE=isolated npx playwright test e2e/customer-reports.spec.ts` | 1/1 grün (Echtdaten aus Isolations-Tenant, Vier-Augen, Portal, Export, Widerruf, Tablet und Desktop) |
| `npm run typecheck -w frontend` | Grün |
| `npm run lint` | Grün |
| `npm run build` | Grün (Backend `tsc`, Frontend `tsc -b` + Vite) |
| PR-CI | 10/10 Checks grün (`verify`, `postgres-integration`, `production-compose`, `restore-drill`, `browser-e2e` für push und pull_request) |
| Browserabnahme | Siehe QA-JSON; acht Schritte bestanden, keine Exportaktion im Portal, keine vertraulichen Freitexte in Berichten |

## 4. Sicherheits- und Datenschutzgrenzen

- Freigabe nur aus `in_review`, durch eine andere Person, mit unverändertem Fingerprint und gespeicherter Zeilenbasis; Selbstfreigabe HTTP 403.
- Neue Version entzieht die Freigabe in derselben Transaktion; Widerruf benötigt Begründung und wirkt sofort.
- Download und Vorschau nur für `available` + `approved` bzw. freigegebene Snapshots; das Portal kennt keine Exportberechtigung.
- Berichtszeilen enthalten nur `id`, `occurred_at`, `site_id`, `site_name`, `category`, `label`, `status`, `metric`; keine Freitexte, Mitarbeiterdaten, internen Notizen oder Bewertungen.
- Mandanten-, RLS- und Scope-Prüfungen bleiben über bestehende `authorization.ts`/`requirePermission` Regelquellen; keine Umgehung über die Legacy-Route.

## 5. Risiken und offene Punkte

- `npm run migrate -w backend` scheitert lokal an einer in der lokalen Migrationstabelle bereits fehlenden DMS-Migration (`069_dms_professionalisierung.sql`). Die Tabelle `customer_report_releases` wurde für die Isolations-DB manuell mit dem exakten DDL aus Migration 069 angelegt. Die Migration selbst ist unverändert und nicht gegen Produktion ausgeführt worden.
- Kein Produktionszugriff, keine Produktionsmigration und kein Produktionsdatenabgleich ohne ausdrückliche Freigabe.
- Externe Benachrichtigungs- und Notrufkanäle sind nicht konfiguriert; ein erfolgreicher Versand wird nicht vortäuscht.
- DMS-PR `#69` und Reporting-PR `#70` bleiben offen; dieser Branch basiert bewusst auf `origin/master` und übernimmt `pdf.ts`/`xlsx.ts` in identischer Fassung aus dem Reporting-Zentrum, damit ein späterer Merge konfliktarm bleibt.
