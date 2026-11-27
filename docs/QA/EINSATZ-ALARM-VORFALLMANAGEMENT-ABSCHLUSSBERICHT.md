# Abschlussbericht – Einsatz-, Alarm- und Vorfallmanagement

Datum: 2026-11-28 · Branch: `feature/operative-leitstelle` · Basis: `a689271`

## 1. Ziel

Vollständiges Einsatz-, Alarm- und Vorfallmanagement in der SecurityOps-Platform: echte Vorfälle, Alarme mit Deduplizierung und Idempotenz, nachvollziehbare Eskalation, bearbeitbare Maßnahmen, Auswertungen und eine UI, die ausschließlich echte Backend-Daten zeigt. Bereits vorhandene Domänen wurden erweitert statt parallele Datenmodelle aufzubauen.

## 2. Bestehende Regelquellen und Datenmodell

- Erweitert wurden die bestehenden Tabellen `incidents`, `alarms`, `escalation_rules` und `notifications`. Keine parallele Vorfalls- oder Alarmverwaltung.
- Neu sind die additiven Migrationen `067_incident_management.sql` und `068_incident_type_bootstrap.sql`: Vorgangsnummern, konfigurierbare Vorfallarten, Priorität, Kunden-/Verantwortlichkeitsfelder, Beteiligte, DMS-Anhänge über `incident_documents`, Bearbeitungsverlauf, Abschlussbedingungen, Alarm-Deduplizierung und Eskalationsprotokoll.
- Migration `066_operations_measures.sql` liefert die gemeinsame Maßnahmentabelle; `001`–`065` blieben unverändert.
- Alle neuen Tabellen besitzen `(tenant_id, id)`-Indizes, RLS und `FORCE ROW LEVEL SECURITY`. Neue Mandanten erhalten über `068` die Standard-Vorfallarten.

## 3. Backend

- `backend/src/routes/incident-management.ts` stellt bereit:
  - `GET/POST /einsatz/incidents`, `GET/PATCH /einsatz/incidents/{id}`, `POST /einsatz/incidents/{id}/status`, Zuweisung und Anhänge.
  - `GET/POST /einsatz/alarms`, `POST /einsatz/alarms/{id}/acknowledge`, `POST /einsatz/alarms/{id}/resolve`.
  - `GET/PATCH /einsatz/measures` und `/einsatz/escalation-rules`, inklusive Regelumschaltung.
  - `GET /einsatz/reports` für echte Auswertungen.
- Vorfallstatuskette: `initiated → en_route → on_site → completed|cancelled`. Ein erzwungener Abschluss verlangt eine Begründung mit mindestens zehn Zeichen. Blockierte Abschlüsse liefern `409` mit `details.open_alarms` bzw. `details.open_measures`.
- Alarmstatus: `open → acknowledged|escalated → resolved`. Das Quittieren beseitigt nie die Ursache. Das Auflösen eines Alarms mit offenem verknüpftem Vorfall wird mit `409 reason_code='linked_incident_open'` verweigert.
- Alarme werden über stabilen `source_key` dedupliziert; wiederholte Ereignisse erzeugen keinen zweiten offenen Alarm. Eskalationen sind konfigurierbar und werden protokolliert.
- Benachrichtigungen laufen über den vorhandenen `queueNotificationEvent`-Dienst. Nicht konfigurierte externe Kanäle werden als nicht versendet ausgewiesen; es wird kein erfolgreicher Versand vorgetäuscht.
- DMS-Anhänge werden ausschließlich über Freigabe-, Versions-, Virenscan- und Berechtigungsregeln verknüpft. Download-/Vorschaulinks zeigen nur auf `/dms/documents/{id}/versions/{versionId}/download|preview`.
- Der Router authentifiziert nur `/einsatz/…` und setzt kein globales CSRF-Middleware auf fremde Pfade.

## 4. Frontend

- Neue Seiten `frontend/src/pages/Einsatz.tsx` und `frontend/src/pages/EinsatzIncidentDetail.tsx`.
- Bereichsnavigation: Übersicht, Vorfälle, Alarme, Maßnahmen, Eskalationen und Auswertungen. Filter, Pagination, Sortierung, Leer-/Lade-/Fehlerzustände und echte Detailnavigation sind enthalten.
- Dialoge für „Vorfall erfassen“, „Status ändern: …“, „Maßnahmenstatus ändern“, „Alarm erledigen“ und „Alarmverlauf“ arbeiten mit echten Backend-Aufrufen und Begründungen.
- Die Vorfallakte zeigt Stammdaten, Beteiligte, Verlauf, Maßnahmen, Alarme und freigegebene DMS-Anhänge. Die Detailschaltfläche der Vorfallliste navigateert zur echten Akte.
- Frontend-Berechtigungen steuern nur die Sichtbarkeit von Bedienelementen; alle Lese- und Schreibzugriffe werden serverseitig geprüft.

## 5. Tests

- Backend: **69 Suites / 642 Tests grün**, einschließlich `einsatz-management.integration.test.ts`, `operations-control-center.integration.test.ts` und OpenAPI-Coverage.
- Frontend: **17 Dateien / 184 Tests grün**.
- E2E gesamt: **50/50 grün**. Die neue Datei `e2e/einsatz-management.spec.ts` deckt Idempotenz, Suche, Statusübergänge, Abschlussbedingungen, Alarmquittierung, Dedupe, Eskalation, Benachrichtigungsstatus, Auswertung, RBAC, Fremdmandant und die UI-Navigation zur Vorfallakte ab.
- Die E2E-Specs sind API-first, durch `E2E_FIXTURE=isolated` abgesichert, verwenden echten Login, CSRF und Capability-Probes über `/api/openapi.json`.
- `npm run typecheck`, `npm run lint` und `npm run build` grün.

## 6. Browserabnahme

- Echter Login als Operator; `/einsatz` und alle sechs Tabs wurden geladen. Die Aufrufe `/einsatz/incidents`, `/alarms`, `/measures`, `/escalation-rules` und `/reports` lieferten `200`.
- Über die UI wurde der echte Vorfall „Browserabnahme: technischer Defekt am E2E-Objekt“ mit Priorität `00000000-0000-4000-8000-000000000107` angelegt: `INC-2026-000001`, ID `ccf59f0c-bf6a-489d-949e-f0e6b32ed039`.
- Die Vorfallakte wurde per Direkt-URL geöffnet und zeigt echte Daten. Die Listen-Navigation zu dieser Akte ist zusätzlich im E2E-Test abgedeckt.
- Filter, Detaildialoge und Statuswechsel wurden mit echten Requests geprüft. Nach dem Abschluss der Leitstellen-Korrektur blieb die Browserkonsole in den Einsatzansichten fehlerfrei; Netzwerk ohne unerwartete 4xx/5xx.
- Rollen- und Mandantengrenzen wurden im Browser über echte Requests geprüft: Viewer ohne Schreibbuttons und `403` bei Schreibversuch; fremder Mandant ohne Zugriff auf Fixture-Vorfälle/-Maßnahmen und `404` bei cross-tenant `PATCH`.
- Responsive Ansichten der Einsatz- und Leitstellenoberfläche sind bei 390 px und 768 px im E2E-Test auf horizontalen Überlauf geprüft.
- Screenshots: `docs/QA/screenshots/einsatz-management.png`, `einsatz-vorfaelle.png`, `einsatz-alarme.png`, `einsatz-massnahmen.png`, `einsatz-eskalationen.png`, `einsatz-auswertungen.png` und `einsatz-vorfall-detail.png`.

## 7. Bekannte Einschränkungen

- Externe Benachrichtigungskanäle sind in der lokalen Testumgebung nicht konfiguriert. Es wird deshalb kein Versand simuliert; die Statusmeldung bleibt „nicht versendet“.
- Eine Produktionsmigration wurde ohne ausdrückliche Freigabe nicht ausgeführt. Produktionsdaten wurden nicht verändert.
- Für den Mandantenwechsel im selben Browser wurde ein Login mit frischer `device_id` verwendet, weil die im Browser gespeicherte Geräteidentität an den Fixture-Mandanten gebunden ist. Die Mandantentrennung selbst wurde über echte Browser-Requests bestätigt.
- `iptv-android/` blieb vollständig unangetastet und wird nicht gestagt.

## 8. Ergebnis

Einsatz-, Alarm- und Vorfallmanagement sind funktionsfähig mit echten Daten umgesetzt. Die Domänen teilen sich die Leitstellen-Maßnahmen und die zentralen Regelquellen; doppelte Geschäftslogik wurde nicht eingeführt. Alle Backend-, Frontend- und E2E-Suites sowie Typcheck, Lint und Build sind grün. Die Browserabnahme ist mit Screenshots, Konsolen- und Netzwerkprüfung abgeschlossen.
