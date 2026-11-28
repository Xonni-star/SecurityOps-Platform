# Reporting-Zentrum – Abschlussbericht

Branch: `feature/reporting-zentrum` (ausgehend von `origin/master` / `daa3456`)
Pull Request: https://github.com/Xonni-star/SecurityOps-Platform/pull/70
Stand: 28.11.2026

## Ziel und Abgrenzung

Das Reporting-Zentrum liefert Live-Auswertungen aus den vorhandenen Fachdaten des
Mandantes. Es gibt bewusst **keine zweite Datenbank, keine Reporting-Tabellen,
keine Materialized Views und keine Mock-Kennzahlen**. Alle Module nutzen den
einzigen PostgreSQL-Pool, die bestehende Mandantentrennung via
`app.tenant_id`/RLS, die bestehende RBAC-Domäne und das zentrale Audit.

Der Branch enthält keinen DMS-Code aus dem noch offenen DMS-PR `#69`. Die
verwendeten DMS-Spalten (`dms_documents`, `dms_versions`) stammen aus der
Basislinie bis Migration `068` und sind unabhängig von Migration `069`.

## Bestandsaufnahme

Vor der Umsetzung wurde `docs/QA/REPORTING-ZENTRUM-BESTANDSAUFNAHME.md`
erstellt. Sie ordnet die Module A–M den realen Fachdomänen zu und legt die
Integrationsentscheidungen fest:

| Modul | Fachdomäne | Quelle |
| --- | --- | --- |
| A | Schicht- und Dienstplanung | `schedule_shifts` |
| B | Qualifikationen | `employee_qualifications` |
| C | Dokumentenmanagement | `dms_documents` |
| D | Aufbewahrung und Fristen | `dms_documents` |
| E | Schlüssel und Ausgabe | `keys` |
| F | Übergaben | `handover_records` |
| G | Instandhaltung | `maintenance_orders` |
| H | Einsätze und Vorfälle | `incidents` |
| I | Alarm- und Leitstellenlage | `alarms` |
| J | Kunden und Objekte | `customer_sites` |
| K | Arbeitszeit | `work_time_entries` |
| L | Operationelle Maßnahmen | `operations_measures` |
| M | Audit und Exporte | `audit_events` |

Der Modulkatalog liegt zentral in `backend/src/services/reporting-domain.ts`;
Filter, Sortierung, Pagination und Site-Scope werden in genau einem
SQL-Vertrag (`reportingQuery`) angewandt.

## Backend

Neue Zentrumsrouten in `backend/src/routes/phase5.ts`:

- `GET /reports/center/modules` – Modulkatalog A–M und Zeitzone.
- `GET /reports/center/overview` – Live-Gesamtzahlen aller 13 Module.
- `GET /reports/center/modules/:slug` – gefilterte, sortierte, seitige Detaildaten.
- `GET /reports/center/export` – CSV/PDF/XLSX mit Audit.

Gemeinsame Filter: `from`, `to`, `site_id`, `customer_id`, `employee_id`, `q`,
`sort`, `order`, `page`, `page_size`. Antworten liefern dieselben Namen in
`snake_case`, inklusive `page_size`.

Weitere Änderungen:

- Kalendertagsgrenzen zentral über `reportingDayRange` in `Europe/Berlin`,
  inklusive Sommer-/Winterzeit; `/reports/statistics` nutzt dieselbe Grenze.
- `phase5Router` wird in `backend/src/app.ts` vor `phase4Router` registriert;
  `/reports/alarms` wird nicht mehr von der alten Phase-4-Route verdeckt. Die
  alte Route bleibt als Fallback erhalten.
- Alle Exporte nutzen `pdfReportLines` aus `backend/src/services/pdf.ts`. Der
  veraltete Inline-PDF-Generator in `customer-reports.ts` ist ersetzt; xref und
  `/Length` werden aus Byte-Offsets berechnet und PDF-Sonderzeichen maskiert.
- Neuer CSV-Dialekt im Zentrum: UTF-8-BOM, Semikolon, `X-Report-Row-Count`,
  `X-Report-Truncated`, maximal 5.000 Zeilen. Legacy-Exporte bleiben
  kompatibel.
- XLSX ohne neue Abhängigkeit über `backend/src/services/xlsx.ts` mit
  gültiger OOXML-Struktur (Content-Types, Relationships, Styles, Inline-Strings).
- Export-Audit über `recordAudit` mit Event `reporting.center.exported` und
  Modul, Format, Zeilenanzahl, Gesamtzahl, Kürzungskennzeichen und Filtern.
- `reports:read` mit `site`-Scope wird aus bestehenden RBAC-Grants abgeleitet
  (`reportingSiteScope`); es gibt keine zweite Rechteprüfung.
- OpenAPI-Einträge für alle neuen und überarbeiteten Reporting-Routen.

## Frontend

`frontend/src/pages/Reports.tsx` ist zum Reporting-Zentrum ausgebaut:

- zentraler Filter mit Objekt-, Kunden-, Mitarbeiter-, Zeitraum- und
  Sucheingaben sowie Sortierung und Pagination,
- Modulkarten A–M mit echten Kennzahlen und Modulauswahl,
- Detailtabelle mit Status-Badges, Kennzahlen und Detaildialog,
- direkte CSV-, PDF- und XLSX-Exporte des ausgewählten Moduls,
- unverändert erreichbare Legacy-Standardexporte,
- durchgängig deutsche Texte und zentrale UI-Bausteine (`Badge`,
  `ResponsiveTable`, `Pagination`, `Modal`, `Section`, `LoadingSkeleton`,
  `Meta`) sowie zentrale deutsche Formatter.

Ohne `reports:read` werden keine Daten geladen und keine Auswertung angezeigt.

## Verifikation

| Prüfung | Ergebnis |
| --- | --- |
| Backend-Tests | 60 Suites bestanden, 590 Tests bestanden (10 Suites / 62 Tests bewusst übersprungen) |
| Frontend-Tests | 18 Dateien, 188 Tests bestanden (inkl. 4 neuer Reporting-Tests) |
| E2E `e2e/reporting-center.spec.ts` | 2 Tests bestanden (Desktop + Tablet) |
| ESLint | 0 Fehler |
| Typecheck Backend/Frontend | 0 Fehler |
| Build Backend/Frontend | erfolgreich |
| XLSX-Struktur | ZIP- und XML-Prüfung erfolgreich (`xmllint`) |
| Export-Audit | 12 `reporting.center.exported`-Ereignisse in der lokalen Testdatenbank nachgewiesen |

## Browserabnahme

Durchgeführt am 28.11.2026 gegen den lokalen Entwicklungsstack
(`http://localhost:5173`, Backend `http://localhost:3000`) mit
Admin-, Operator- und Viewer-Sitzung.

| Nr. | Prüfpunkt | Ergebnis |
| --- | --- | --- |
| 1 | Anmeldung und Navigation zu „Auswertungen“ | bestanden |
| 2 | Modulkarten A–M mit Live-Zahlen aus echten Fachtabellen | bestanden |
| 3 | Zentraler Filter mit Berliner Kalendertagsgrenzen | bestanden |
| 4 | Filterwechsel aktualisiert Overview und Detailansicht | bestanden |
| 5 | Modul „Dokumentenmanagement“ zeigt 102 Datensätze und 5 Seiten | bestanden |
| 6 | Detaildialog zeigt Objekt, Kunde, Mitarbeiter und Kennzahl | bestanden |
| 7 | CSV-, PDF- und XLSX-Downloads liefern 200 mit Row-Count-Header | bestanden |
| 8 | Exporte werden im Auditprotokoll erfasst | bestanden |
| 9 | Viewer-Sicht ohne Berechtigungsfehler und ohne Konsolenfehler | bestanden |
| 10 | Tablet-Ansicht 768 × 1024 ohne Umbruchfehler | bestanden |
| 11 | Keine Browser-Konsolenfehler während der Abnahme | bestanden |

Screenshots:

- `docs/QA/screenshots/reporting-center-filter-desktop.png`
- `docs/QA/screenshots/reporting-center-detail-desktop.png`
- `docs/QA/screenshots/reporting-center-viewer-desktop.png`
- `docs/QA/screenshots/reporting-center-tablet.png`

## Einschränkungen

- Produktionsdaten, Produktionsmigrationen und ein Produktionsdatenabgleich
  wurden ohne Zugang und Freigabe nicht durchgeführt.
- Externe Benachrichtigungs- und Notrufkanäle sind nicht konfiguriert; es wird
  kein erfolgreicher Versand vortäuscht.
- Die lokale Testdatenbank enthält noch die Migration `069` aus dem DMS-Branch;
  dieser Reporting-Branch enthält nur die Migrationen `001`–`068` und benötigt
  `069` nicht.

## Abschluss

Das Reporting-Zentrum ist funktional vollständig umgesetzt, getestet und
browserabgenommen. Der Branch wird per Commit/Push und Pull Request
abgeschlossen; ein direkter Merge nach `master` erfolgt nicht.
