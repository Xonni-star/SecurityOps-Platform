# Abschlussbericht – NFC-Geräteverwaltung

Datum: 2026-11-27 · Branch: `feature/nfc-device-management-review` · Basis: `950c897`

## 1. Untersucht

- Bestandsaufnahme der Routen `Verwaltung → NFC-Geräte` und `Geräteakte` in `frontend/src/pages/NfcDevices.tsx`, `NfcDeviceFile.tsx` und `nfcParts.tsx`.
- Backend-Vertrag in `backend/src/routes/nfc-management.ts` und `backend/src/routes/phase6.ts`: Overview, Inventar, Filteroptionen, Geräteakte, Scan-Historie und Austausch-Workflow.
- Datenmodell der Migration `060_nfc_device_management.sql`, particularly `archived_at`, `replaced_at`, `nfc_device_assignment_history`, `nfc_device_replacements` und `audit_events`.
- Bestehende Tests: `frontend/tests/nfc-devices.test.tsx`, `backend/tests/nfc-management.test.ts`, `backend/tests/nfc-lifecycle.integration.test.ts` und `e2e/nfc-device-lifecycle.spec.ts`.
- Austauschlogik unverändert: `acknowledged_device_id`-Bindung, Snapshot-Validierung, `copy_assignment`-Freigabe, Transaktionen, Rollback und Audit.

## 2. Fehler gefunden

1. **Overview 500 im echten Browser:** Die SQL-Abfrage filterte auf `nfc_devices.deleted_at`, eine Spalte, die im Schema nicht existiert.
2. **KPI-Filter machte Selects unkontrolliert:** Beim Abwählen eines KPI wurden Filterfelder mit `delete` entfernt; React meldete `A component is changing a controlled input to be uncontrolled`.
3. **Zeitfenster-/Filterinkonsistenz:** Overview, Inventar, „Kürzlich verwendet“ und Scan-Historie konnten unterschiedliche Zeiträume oder Quellsignale verwenden; `replaced` erkannte `replaced_at` nicht zuverlässig.
4. **Suche mit LIKE-Wildcards:** `%`, `_` und `\` in der Suche wurden nicht maskiert und konnten mehr Treffer liefern als eingegeben.
5. **Ungültige Datumsbereiche** führten zu unscharfen oder nicht deutsch lokalisierten Fehlern.
6. **Historien unvollständig bzw. nicht deterministisch:** `LIMIT 100` und fehlende Sekundärsortierung konnten Ereignisse verschweigen oder Reihenfolgen vermischen.
7. **Roh-UUID statt Actor-Email:** `reported_by` wurde in der Geräteakte als UUID angezeigt.
8. **Geräteakte ohne Lese-Guard und mit gemeinsamem Dirty-State:** Berechtigungsfehler und ungespeicherte Stammdaten/Zuordnungen wurden nicht sauber getrennt.
9. **Bestätigungsbindung unvollständig:** Modell, Seriennummer und Beschreibung des Ersatzgeräts fehlten in Zusammenfassung, Validierung und Payload; veraltete Bestätigungen konnten fachlich wirken.
10. **E2E-Lauf scheiterte initial an der Login-Rate-Limitierung** (10 Logins/15 min) mit 10 Fehlschlägen, nicht an NFC-Fachlogik.

## 3. Fehler behoben

- `deleted_at`-Filter aus Overview/Scan-Join entfernt; der echte Browser liefert wieder `200` und echte Kennzahlen.
- KPI-Toggle setzt betroffene Filter auf `''` statt sie zu löschen; Selects bleiben kontrolliert, keine React-Warnung mehr.
- Ein einheitliches `timeWindow` im Frontend und `days`/`from`/`to` im Backend für Overview, Inventar, Kürzlich-Filter und Scan-Historie; `days` auf 1–365 begrenzt.
- `likeNeedle()` maskiert `\`, `%` und `_`; `replaced` berücksichtigt Status und `replaced_at`.
- `dateBoundary()` gibt bei ungültigen Daten `400` mit `Ungültiger Zeitraum. Bitte ein gültiges Datum angeben.` zurück.
- Alle Gerätehistorien ohne `LIMIT`, mit deterministischer Sortierung nach Zeitstempel und `id`.
- `reported_by_email` via `users`-Join; Anzeige zeigt lesbare Email statt UUID.
- Geräteakte: `canRead`-Guard, getrennte `masterDirty`/`assignmentDirty`, Verlassschutz, Erfolg erst nach Speichern, Scan-Abort und verständliche Downloadfehler.
- Austauschdialog: Snapshot über alle relevanten Felder inkl. `model`, `serial_number`, `description`; jede fachliche Änderung entzieht die Bestätigung. Backend verlangt `acknowledged_device_id` bei gesetzten Acks (`400` bzw. `409` bei Abweichung).
- E2E-Rate-Limit lokal für den Verifikationslauf erhöht (`LOGIN_RATE_LIMIT_MAX=200`); keine Schwächung der Produktionskonfiguration.

## 4. Funktionen verbessert

- Primäre KPIs (registriert, aktive Tags, aktive Lesegeräte, gesperrt, verloren, nicht zugeordnet) in der Hauptreihe; ersetzt, archiviert, kürzlich verwendet und Scan-Anzahl über „Weitere Kennzahlen anzeigen“.
- Alle KPIs klickbar und filternd; aktive Filter als Chips, Einzelentfernung, Gesamt-Reset und Trefferzahl.
- Schnellfilter und erweiterte Filter, Persistenz in der URL, Sortierung, serverseitige Suche mit Debounce/Abort, Pagination und `pageSize`.
- Klare Status-/Datumsanzeige, kontextbezogene Aktionen mit RBAC, Bestätigungen für Sperren, Verlust, Archivierung und Austausch.
- Lade-, Leer-, Fehler-, Retry- und Berechtigungszustände; mobile Tabellenkarten mit `data-label`, größere Touch-Ziele.
- Geräteakte mit sechs erhaltenen Tabs, staging-gerechte Historien, Actor/Grund/Bemerkung und Volltext-Dokumentenfehlern.

## 5. Dateien geändert

| Datei | Zweck |
|---|---|
| `backend/src/routes/nfc-management.ts` | Zeitfenster, KPIs, Inventarfilter, Scan-Historie, Historien, Actor, Austauschgrenze |
| `backend/tests/nfc-management.test.ts` | Zeitfenster, Wildcards, Historien, Bestätigungsbindung |
| `backend/tests/nfc-lifecycle.integration.test.ts` | Typkorrektur `Row`; Lebenszyklus/Parallelität/Rollback |
| `frontend/src/pages/NfcDevices.tsx` | KPIs, Filter, Sortierung, Pagination, URL-Zustand, RBAC |
| `frontend/src/pages/NfcDeviceFile.tsx` | Dirty-Split, Guards, Scan-Fenster, Historie, Dialogfelder |
| `frontend/src/pages/nfcParts.tsx` | Formular-/Zusammenfassungs-/Snapshot-Vertrag, KPI-Karte, Timeline |
| `frontend/src/polish.css` | KPI-, Filter-, Chip-, Timeline-, Mobile- und Touch-Styles |
| `frontend/tests/nfc-devices.test.tsx` | 15 Szenarien plus Regressionstests |
| `docs/QA/screenshots/*.png` | 8 echte Browser-Screenshots (Desktop, Tablet, Smartphone) |
| `docs/QA/NFC-GERAETE-ABSCHLUSSBERICHT.md` | Dieser Bericht |

## 6. Migrationen

Keine neuen oder geänderten Produktionsmigrationen. Die vorhandene Migration `060_nfc_device_management.sql` bleibt unverändert; alle Korrekturen erfolgen in Query-, Validierungs- und UI-Schicht. Für PostgreSQL-Integrationstests wurde temporär `securityops_nfc_qa` angelegt, migriert (62 Migrationen) und nach Abschluss wieder gelöscht.

## 7. Tests ausgeführt

- `npm run typecheck` (Backend + Frontend)
- `npm run lint`
- `npm run build` (Backend + Frontend/Vite)
- `npm test -w frontend -- --run`
- `npm test -w backend -- --runInBand`
- PostgreSQL-Integration: `nfc-lifecycle.integration.test.ts` sowie `(rls|watchbook|crm-migration|keys-rls|employee-profile|employee-integrity).integration.test.ts` der bestehenden CI-Suites
- `npm run test:e2e` mit isolierten Fixture-Zugangsdaten
- `npm run test:production-compose`
- Echter Browser-Rundgang mit 1440/820/390 px, Konsolen-/Netzwerkprüfung und Screenshots

### Abdeckung der 15 geforderten Szenarien

| # | Szenario | Absicherung |
|---:|---|---|
| 1 | Create | Frontend-Registrierung inkl. Modell/Serie/Beschreibung; Integration `registers active devices` |
| 2 | Edit | Frontend `trennt Stammdaten von der Zuordnung …`; Integration `persists every technical master-data field …` |
| 3 | Assign | Backend `assigns a control point, writes assignment history …`; Frontend `speichert eine neue Zuordnung …` |
| 4 | Change assignment | Backend `enforces one active tag per control point on assignment changes`; Frontend `verhindert Zuordnungsänderungen an gesperrten Geräten …` |
| 5 | Block | Frontend `führt eine bestätigungspflichtige Sperre …`; Backend `blocks and reactivates only in valid states …` |
| 6 | Unblock | Backend-Reaktivierung mit Status-/Rollencheck; Frontend `Wieder in Betrieb` |
| 7 | Lost | Frontend `meldet Verlust mit Datum und Begründung …`; Backend `reports loss with date and reason …` |
| 8 | Select replacement | Frontend `zeigt im Austauschdialog …`; Backend `offers real devices as replacement options` |
| 9 | Valid replacement | Frontend `tauscht gegen ein vorhandenes Gerät …`; Backend `replaces a device with an existing tenant device …` |
| 10 | Invalid confirmation | Frontend Szenarien A–E; Backend `binds confirmations to the submitted replacement device …` |
| 11 | Parallel replacement | Integration `performs exactly one of two concurrent replacements …` für unterschiedliche und identische Kandidaten |
| 12 | Archive | Frontend `archiviert ein Gerät über den begründeten Workflow`; Backend `archives a device without changing its scan history …` |
| 13 | History | Frontend `zeigt Stammdaten, Zuordnungshistorie …`; Backend vollständige Geräteakte; Integration `keeps historical assignments …` |
| 14 | Scan history | Frontend `lädt die echte Scan-Historie …`; Backend `returns paginated accepted and rejected scans …`; Integration `returns more than 200 real scans …` |
| 15 | Roles | Frontend `verweigert die Übersicht ohne Leseberechtigung` / `blendet schreib- … aus`; Backend `requires … permission`; Integration Mandanten-, Rollen- und CSRF-Tests |

## 8. Tests erfolgreich

- Typecheck, Lint und Build: grün.
- Frontend: 13 Dateien / **150 Tests** grün.
- Backend-Unit: 51 Suites / **437 Tests** grün (37 bewusst übersprungen).
- PostgreSQL-Integration: 7 Suites / **37 Tests** grün.
- Backend-NFC-Suite allein: **46/46** grün.
- `npm run test:e2e`: **17/17** grün, davon 4 NFC-Suite-Tests (1440/820/390 px und vollständiger Lebenszyklus).
- `npm run test:production-compose`: grün.
- Browser-QA: Overview und Akte ohne horizontalen Dokumentüberlauf bei 1440/820/390 px; Geräteakte zeigt sechs Tabs; Ersatzdialog bleibt im Viewport; **keine Konsolenfehler und keine HTTP-5xx**; identische `days`/`from`/`to` in Overview und Inventar.
- Screenshots: `docs/QA/screenshots/01-nfc-overview-desktop.png` bis `08-nfc-overview-smartphone.png`.

## 9. Tests fehlgeschlagen

- Erster E2E-Lauf: 10 Fehlschläge ausschließlich durch `429 Zu viele Anmeldeversuche` der bestehenden Login-Rate-Limitierung; 7 Tests liefen durch. Ursache war die Anzahl der Logins mehrerer Suiten innerhalb von 15 Minuten, nicht die NFC-Implementierung.
- Weitere vorübergehende E2E-Fehler waren Umgebungs- und Testwartungsprobleme: Tool-Timeouts beendeten Dev-Server, das lokale API-Limit (120/min) lieferte `429`, und der ClamAV-Container war ohne veröffentlichten Port vom Host nicht erreichbar (`502` beim DMS-Upload). Nach stabilen Diensten und erhöhten lokalen Testlimits liefen alle 17 Tests grün. Die Produktionskonfiguration blieb unverändert.
- Zwei veraltete NFC-E2E-Selektoren wurden an das finale UI angepasst: „Archiviert“ liegt hinter „Weitere Kennzahlen anzeigen“, und die Tabellenköpfe der Scan-Historie sind bei ≤700 px zugunsten der Kartenansicht ausgeblendet.
- Während der Entwicklung vorübergehend rot und anschließend behoben: Overview-500 durch `deleted_at`, Mock-Fehler im Zeitraumtest, React-Warnung durch gelöschte KPI-Filterfelder.

## 10. Offene Probleme

- Die Produktions-Login-Limitierung bleibt bewusst bei 10 Anmeldungen/15 min und das API-Limit bei 120/min. Für den lokalen E2E-Lauf wurden `LOGIN_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX` und der ClamAV-Port nur in der Testumgebung angepasst; die Produktionskonfiguration und `docker-compose.yml` blieben unverändert.
- Auf 1440 px besitzt die breite Tabelle einen kontrollierten horizontalen Scrollbereich im Container (`overflow-x: auto`); Daten sind vollständig erreichbar. Auf Tablet/Smartphone greift die Kartenansicht ohne Dokumentüberlauf.
- Die erzeugten PNGs konnten in diesem Bearbeitungskontext nicht visuell inspiziert werden; Layout, Viewport-Grenzen, Tabs, Dialog und Fehlerfreiheit wurden dafür programmatisch im echten Browser geprüft.
- Keine offenen fachlichen Fehler in der Austausch-, Berechtigungs- oder Historienlogik bekannt.
- Die Aufnahme von `nfc-lifecycle` in den PostgreSQL-CI-Testfilter (`.github/workflows/ci.yml`) ist bewusst nicht Teil dieses PRs: das verfügbare GitHub-OAuth-Token besitzt keinen `workflow`-Scope. Die Suite wurde lokal gegen PostgreSQL ausgeführt und ist grün; die CI-Anbindung kann nach Erteilung des Scopes in einem separaten Commit erfolgen.
