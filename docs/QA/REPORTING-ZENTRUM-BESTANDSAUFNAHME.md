# Bestandsaufnahme Reporting-Zentrum

Stand: 28.11.2026 · Branch `feature/reporting-zentrum` · Ausgangspunkt `origin/master` (`daa3456`)

## 1. Ziel und Reihenfolge

Das Reporting-Zentrum baut ausschließlich auf dem vorhandenen DMS-/Fachdatenbestand auf. Es darf erst nach Abschluss und Push des DMS-Auftrags (#69) bearbeitet werden; der Branch enthält deshalb bewusst keine DMS-Änderungen. Kundenberichte folgen auf einem eigenen Branch mit eigenem Abschlussbericht.

## 2. Backend-Bestand

| Datei | Rolle | Befund |
| --- | --- | --- |
| `backend/src/routes/phase5.ts` | Zentrale Reporting-Routen | `/reports/statistics`, `/reports/:kind`, Filter, CSV/PDF, Audit; ohne Modulkatalog, ohne einheitliche Berliner Tagesgrenzen, ohne XLSX. |
| `backend/src/routes/phase4.ts` | NSL + Alarm-Export | `/reports/alarms` wurde vor Phase 5 registriert und shadowte die gefilterte Variante; eigener CSV/PDF-Builder. |
| `backend/src/routes/customer-reports.ts` | Kunden-Nachweise/Portal | Eigener, veralteter PDF-Generator mit festem `startxref 0`; `customer_portal:read` nur JSON, Export nur mit `customer_reports:export`. |
| `backend/src/services/pdf.ts` | Kanonischer PDF-Generator | Korrigierte xref-Offsets und Byte-Längen; jetzt um mehrzeilige, maskierte Ausgabe erweitert. |
| `backend/src/services/audit.ts` | Kanonisches Audit | `recordAudit(..., client?)`; Phase 5 nutzte vorher direkten `INSERT`. |
| `backend/src/db/pool.ts` | Einziger Pool | RLS-Kontext `app.tenant_id`; keine zweite Datenbank. |
| `backend/src/types/authorization.ts` | RBAC | Scopes `own`, `site`, `tenant`, `system`; `effectivePermissionScope` und `canAccessResource` sind Regelquellen. |
| `backend/src/openapi.ts` | API-Dokumentation | Enthielt nur die alten Reporting-Pfade; neue Zentrumsrouten ergänzt. |

## 3. Datenbestand und Module A–M

Alle Kennzahlen kommen live aus bestehenden transaktionalen Tabellen. Es gibt keine Reporting-Tabellen, Materialized Views, Mocks oder Beispieldaten.

| Modul | Name | Quelltabelle(n) |
| --- | --- | --- |
| A | Schicht- und Dienstplanung | `schedule_shifts`, `schedule_periods`, `schedule_assignments`, `employees` |
| B | Qualifikationen | `employee_qualifications`, `qualification_catalog`, `employees` |
| C | Dokumentenmanagement | `dms_documents`, `dms_versions` |
| D | Aufbewahrung und Fristen | `dms_documents` (`valid_until`) |
| E | Schlüssel und Ausgabe | `keys` |
| F | Übergaben | `handover_records` |
| G | Instandhaltung | `maintenance_orders` |
| H | Einsätze und Vorfälle | `incidents`, `alarm_priorities` |
| I | Alarm- und Leitstellenlage | `alarms`, `alarm_priorities` |
| J | Kunden und Objekte | `customer_sites`, `customers`, `sites` |
| K | Arbeitszeit | `work_time_entries` |
| L | Operationelle Maßnahmen | `operations_measures` |
| M | Audit und Exporte | `audit_events` |

Der Modulkatalog wird zentral in `backend/src/services/reporting-domain.ts` definiert und von API, Frontend und Exporten gemeinsam genutzt.

## 4. Frontend-Bestand

| Datei | Befund |
| --- | --- |
| `frontend/src/pages/Reports.tsx` | Bestehender, einfacher Einstieg; wird zum Reporting-Zentrum ausgebaut, keine Parallelseite. |
| `frontend/src/pages/CustomerReports.tsx` | Bewährtes Muster für Berlin-Datumskonvertierung, Filter und Portal. |
| `frontend/src/pages/Einsatz.tsx` | `ReportPanel` als stärkstes Karten-/Tabellenmuster. |
| `frontend/src/pages/OperativeLeitstelle.tsx` | Dashboard-, Filter- und Responsive-Muster. |
| `frontend/src/components/operative/Common.tsx` | `Badge`, `Section`, `ResponsiveTable`, `Pagination`, `Modal`, Lade-/Leer-/Fehlerzustände. |
| `frontend/src/lib/format.ts` | `de-DE`, `Europe/Berlin`, Datumskonvertierung. |
| `frontend/src/lib/text.ts` | Zentrale deutsche Helper. |

## 5. Bekannte Konflikte und Entscheidungen

1. **Shadowing:** `phase4Router` war vor `phase5Router` registriert. Die Phase-4-Route `/reports/alarms` hatte keine Objekt-/Mitarbeiterfilter und eigenen Exportcode. Entscheidung: Phase 5 vor Phase 4 registrieren; die zentrale Route ist jetzt maßgeblich, der alte Pfad bleibt als Fallback erhalten. Alle übrigen Pfade sind disjunkt.
2. **PDF:** `customer-reports.ts` nutzte einen eigenen Generator mit ungültiger xref-Tabelle. Entscheidung: `pdfReportLines` aus `services/pdf.ts` für alle Exporte.
3. **Zeitzone:** Roh-`Date` gegen `timestamptz` erzeugte Tagesgrenzen in UTC. Entscheidung: `Europe/Berlin` als zentrale Kalendertagsgrenze für alle neuen Filter; bestehende `/reports/statistics`-Parameter werden auf Berliner Tagesgrenzen umgestellt.
4. **CSV-Dialekte:** Alt-Exporte nutzten Komma ohne BOM und uneinheitliche Limits. Entscheidung: neuer, einheitlicher Dialekt mit BOM, Semikolon, `X-Report-Row-Count`, `X-Report-Truncated` und 5.000 Zeilen Obergrenze im Zentrum; alte Endpunkte bleiben kompatibel.
5. **XLSX:** Keine `exceljs`/`xlsx`-Abhängigkeit vorhanden. Entscheidung: abhängigkeitsfreier OOXML-Writer mit gültigem ZIP-Container, Inhaltstypen, Relationships, Styles und Inline-Strings.
6. **Scope:** `reports:read` mit `site`-Scope wird über `reportingSiteScope` aus der bestehenden RBAC-Domäne abgeleitet. Keine zweite Rechteprüfung, keine clientseitigen Rechteentscheidungen.
7. **Audit:** Jeder Zentrums-Export erzeugt `reporting.center.exported` über `recordAudit` mit Modul, Format, Zeilenanzahl, Gesamtzahl, Kürzungskennzeichen und Filtern.

## 6. Umsetzungsgrenzen

- Kein Zugriff auf Produktionsdaten oder Produktionsmigrationen ohne ausdrückliche Freigabe.
- Keine externen Benachrichtigungs-/Notrufkanäle aktiv; successful delivery wird nicht vorgetäuscht.
- `iptv-android/` bleibt untracked und unangetastet.
- Keine direkten Merges nach `master`; Abschluss über eigenen Pull Request.
