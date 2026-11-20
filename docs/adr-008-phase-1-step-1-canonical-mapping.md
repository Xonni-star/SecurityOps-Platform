# ADR-008: Kanonisches Mapping für die Merge-Portierung

## Status

Angenommen für Phase 1, Schritt 1. Diese ADR ändert keine Migration und
führt noch keine Kompatibilitätstabellen oder Alias-Routen ein.

## Kontext

`SecurityOps-Platform` ist die Zielbasis. Die Alfa-Namen stammen aus der
Phase-0-Analyse von `Xonni-star/AlfaSecuritySoft`; das Alfa-Repository ist in
diesem Checkout nicht enthalten. Die folgenden Zielnamen sind gegen die neun
vorhandenen Migrationen, Backend-Routen und Typen dieses Repositories
verifiziert.

Die gemeinsame Nomenklatur muss Datenverlust, doppelte Domänenmodelle und
unklare Berechtigungssemantik bei den nächsten Schritten verhindern. Sie muss
außerdem die freigegebenen Entscheidungen respektieren: MFA bleibt später,
PWA und Capacitor-Android bleiben, DMS wird später mit Self-hosted MinIO +
ClamAV ergänzt, und Dienstplanung bleibt ein späteres Modul mit generischen
Regelprofilen.

## Entscheidung

### 1. Zielbasis und Benennungsregeln

- **Canonical Owner:** `SecurityOps-Platform` besitzt Tabellen-, API- und
  Permission-Namen für bereits implementierte Funktionen.
- **IDs:** Jede persistierte Entität verwendet eine PostgreSQL-`uuid` als
  `id`; neue Beziehungen behalten zusätzlich `tenant_id`. Alfa-Composite-
  Schlüssel `(id, tenant_id)` werden in späteren Schritten als Integritäts-
  und RLS-Vertrag übernommen, nicht durch neue parallele IDs ersetzt.
- **Mandant:** `tenant` / `tenant_id` ist der kanonische Begriff. Alfa
  `tenant` bleibt semantisch identisch.
- **Objekt:** `site` / `site_id` ist kanonisch. Alfa-Site-Scope bezieht sich
  auf diese Entität und darf nicht als neue `client`- oder `location`-
  Entität eingeführt werden.
- **Kunde:** `customers` / `customer` ist kanonisch. Alfa `clients` ist ein
  Kompatibilitätsname und wird bei Import/API-Anpassungen auf `customers`
  abgebildet; es entsteht keine zweite Kundentabelle.
- **Benutzerkonto:** `users` / `user` ist kanonisch. Alfa `user_sessions`
  wird auf die bestehende Session-Domäne `sessions` abgebildet.
- **Mitarbeiter:** `employees` / `employee` ist kanonisch. Alfa
  `employee_qualifications`, Abwesenheiten und Site-Zuordnungen sind
  spätere Erweiterungen derselben Mitarbeiterdomäne.
- **Alarm:** `alarms` / `alarm` ist kanonisch. Priorität, Verlauf,
  Eskalation und Sensorereignis bleiben Unterdomänen der Alarm-/Telemetry-
  Verträge und werden nicht als Alfa-`incident` umbenannt.
- **Einsatz/Vorfall:** `incidents` / `incident` ist kanonisch für den
  aktuellen Einsatzlebenszyklus. Alfa `emergency_plans` und
  `incident_events` sind zukünftige Erweiterungen, keine Umbenennung von
  `alarms`.
- **Kontrollgang:** `patrol_routes`, `control_points`, `patrol_scans` und
  `patrol_assignments` sind kanonisch. Alfa `checkpoints`,
  `route_versions`, `rounds` und `scan events` werden bei der späteren
  Übernahme auf diese Domäne gemappt.
- **Übergabe:** `shift_handovers` ist kanonisch für die bereits vorhandene
  Übergabe. Alfa `handovers` wird darauf abgebildet; zusätzliche Teilnehmer,
  Ereignisse, Bestätigungen und Aufgaben werden später additiv ergänzt.
- **Kommunikation:** `messages`, `notifications` und
  `notification_subscriptions` sind kanonisch. Alfa `notifications`,
  `notification_deliveries` und Provider-Zustände werden auf diese
  Unterdomänen verteilt.
- **Audit:** `audit_events` ist kanonisch für die bestehende tenant-scoped
  Audit-Domäne. Alfa `audit_logs` und zusätzliche append-only Ereignisse
  werden später in diesen Vertrag integriert.
- **Mobile:** `client_event_id` ist der kanonische Idempotenzschlüssel für
  bereits unterstützte mobile Alarm- und Patrol-Schreibvorgänge.
  Alfa `client_mutation_id` wird an der Sync-Grenze darauf abgebildet; die
  geplante Sync-Receipt-Domäne bleibt ein späterer Schritt.

### 2. Verifiziertes SecurityOps-Modell

| Domäne            | Kanonische Entitäten/Tabellen                                                                                     | IDs und wichtige Werte                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Mandant/Auth      | `tenants`, `users`, `sessions`                                                                                    | UUID; Rollen `admin`, `operator`, `viewer`                                                                     |
| Stammdaten        | `employees`, `customers`, `sites`, `devices`                                                                      | UUID; Gerätestatus `online`, `offline`, `maintenance`                                                          |
| Alarm             | `alarms`, `alarm_priorities`, `alarm_history`, `escalation_rules`                                                 | Schweregrade `low`, `medium`, `high`, `critical`; Alarmstatus `open`, `acknowledged`, `escalated`, `resolved`  |
| Patrol/NFC        | `control_points`, `patrol_routes`, `patrol_route_points`, `patrol_assignments`, `patrol_scans`, `nfc_devices`     | NFC-Status `active`, `lost`, `blocked`, `replaced`; Scan-Abweichung enthält aktuell `none` bzw. `out_of_order` |
| Telemetry/Einsatz | `sensor_thresholds`, `sensor_events`, `device_positions`, `incidents`, `incident_assignments`, `incident_history` | Einsatzstatus `initiated`, `en_route`, `on_site`, `completed`                                                  |
| Kommunikation     | `notification_subscriptions`, `notifications`, `notification_deliveries`, `direct_messages`, `shift_handovers`    | Delivery `pending`, `processing`, `sent`, `failed`; Übergabe `open`, `acknowledged`                            |
| Reporting/Privacy | `work_time_entries`, `timescan_connections`, `timescan_sync_runs`, `retention_policies`, `audit_events`           | Arbeitszeit `imported`, `adjusted`, `deleted`; Sync `running`, `completed`, `failed`                           |
| Mobile            | `push_subscriptions` plus `client_event_id`-Unique-Indizes                                                        | Push-Subscription ist tenant-/userbezogen; keine neue Geräte-ID in diesem Schritt                              |

Alle in diesem Abschnitt genannten Tabellen und Statuswerte sind aus
`backend/migrations/001_init.sql` und `003` bis `009` sowie den zugehörigen
Backend-Validierungen abgeleitet. `uuid` ist der verbindliche API- und
Datenbanktyp; UUID-Strings werden nicht in numerische oder systemspezifische
Alfa-IDs konvertiert.

### 3. Alfa-Referenz auf die gemeinsame Domäne

| Alfa-Name aus Phase 0                                           | Kanonischer Owner                                                        | Mapping-Regel                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `tenants`, `users`, `sites`, `employees`                        | Gleichnamige SecurityOps-Domäne                                          | Direkte UUID-/`tenant_id`-Zuordnung                                              |
| `clients`                                                       | `customers`                                                              | `client` ist nur Import-/Kompatibilitätsalias                                    |
| `user_sessions`                                                 | `sessions`                                                               | Session-Sicherheitsmerkmale werden in Schritt 5 vereinheitlicht                  |
| `roles`, `permissions`, `role_permissions`, `user_roles`        | `permissions`, `role_permissions`                                        | Zielschlüssel bleiben SecurityOps-Codes; Alfa-Scope wird als Grant-Scope ergänzt |
| `employee_qualifications`, employee-site assignments            | `employees` plus spätere Qualifikations-/Site-Unterdomänen               | Keine parallele Mitarbeiterentität                                               |
| `patrol_checkpoints`, `route_versions`, `rounds`, patrol events | `control_points`, `patrol_routes`, `patrol_route_points`, `patrol_scans` | Versionierung und Receipt-Verträge kommen additiv                                |
| `handovers`, participants/events/confirmations                  | `shift_handovers`                                                        | Bestehende Übergabe bleibt Owner                                                 |
| `alarm types`, alarm events/status history/escalation           | `alarms`, `alarm_priorities`, `alarm_history`, `escalation_rules`        | Alarm bleibt von `incidents` getrennt                                            |
| `emergency_plans`, `incidents`, `incident_events`               | `incidents`                                                              | Einsatzstatus bleibt `initiated` → `en_route` → `on_site` → `completed`          |
| `audit_logs`                                                    | `audit_events`                                                           | Append-only-/RLS-Härtung folgt in Schritt 3                                      |
| `sync_idempotency_receipts`, conflict receipts                  | `client_event_id`-Vertrag und spätere Sync-Receipt-Domäne                | Keine neue Receipt-Tabelle in Schritt 1                                          |
| `guardbook_entries`, `keys`, `tasks`, DMS, SOP, planning        | Noch kein SecurityOps-Owner                                              | Spätere additive Module; keine vorgezogene Umbenennung oder Schemaanlage         |

Die Phase-0-Analyse nennt für Alfa zusätzlich `TENANT`, `SITE` und `OWN`
als Datenzugriffssichten. Diese Begriffe werden als **Grant-Scope**, nicht als
Teil des Permission-Key-Strings, kanonisiert. Ein konkretes Alfa-Permission-
Inventar mit Literalen ist vor der Übernahme der Alfa-Migrationen erneut
gegen den Alfa-Quellstand zu prüfen; aus der Analyse werden keine nicht
belegten Schlüssel erfunden.

### 4. Kanonische Permission-Codes

SecurityOps verwendet `resource:verb` als kanonisches Format. Die aktuell
belegten Codes sind:

```text
employees:read employees:write employees:delete
customers:read customers:write customers:delete
sites:read sites:write sites:delete
devices:read devices:write devices:delete
alarms:read alarms:write alarms:delete
alarm_priorities:read alarm_priorities:write
escalation_rules:read escalation_rules:write
patrols:read patrols:write
telemetry:read telemetry:write
positions:read positions:write
incidents:read incidents:write
nsl:read nsl:write
reports:read
messages:read messages:write
notifications:read notifications:write
timescan:read timescan:write
audit:read privacy:write backup:read
nfc_devices:read nfc_devices:write
push_subscriptions:write
```

Kompatibilitätsregeln für Alfa:

1. Ein Alfa-Code wird nur dann übernommen, wenn seine Ressource auf eine
   obige kanonische Ressource oder ein später ausdrücklich freigegebenes
   Modul zeigt.
2. `TENANT`, `SITE` und `OWN` werden als Scope eines Grants modelliert;
   `resource:verb` bleibt stabil und wird nicht durch frei formatierte
   Suffixe wie `:site` oder `:own` vervielfacht.
3. Ein Import darf keine Berechtigung durch bloße Rollen-Namensgleichheit
   gewähren. Die Zielprüfung bleibt permission-code- und später
   scope-basiert.
4. Bis Schritt 4 existiert keine Alfa-Code-Kompatibilitätsalias-Tabelle.
   Ein solcher Alias muss befristet, messbar und mit Deprecation-Datum
   eingeführt werden; neue Writes verwenden ausschließlich kanonische Codes.

### 5. Status- und Lebenszyklusregeln

- Gleiche Semantik wird direkt übernommen: `open`, `acknowledged`,
  `resolved`, `failed`, `completed` und `active` behalten ihre Schreibweise.
- SecurityOps `alarms.status` enthält zusätzlich `escalated`; Alfa-
  Eskalationszustände werden darauf abgebildet, nicht als neuer Status
  eingeführt.
- SecurityOps `incidents.status` ist der kanonische Einsatzlebenszyklus.
  Alarmstatus und Einsatzstatus dürfen nicht gegenseitig ersetzt werden.
- Statuswerte werden als kleinschreibende, API-stabile Literale behandelt.
  Lesbare deutsche UI-Texte sind Übersetzungen und keine Persistenzwerte.
- Alfa-Lifecycle-Werte, die in der Phase-0-Dokumentation nicht als konkrete
  Literale belegt sind, dürfen erst nach einem Quellstand-Inventar gemappt
  werden. Bis dahin gibt es keinen stillen Fallback und keine automatische
  Konvertierung.

## Kompatibilität und Deprecation

- Schritt 1 ist dokumentarisch. Bestehende Migrationen, Tabellen, API-Routen,
  Permission-Keys und UUIDs bleiben unverändert.
- Für spätere Imports wird eine explizite Mapping-Schicht verwendet:
  Alfa-Namen dürfen am Eingang akzeptiert, aber intern sofort auf den
  kanonischen Owner normalisiert werden. Antworten und neue Persistenz
  verwenden nur kanonische Namen.
- Kein Alias darf eine zweite Tabelle, eine zweite Statusmaschine oder eine
  zweite Permission-Matrix erzeugen.
- Jeder Alias erhält eine Telemetrie-/Audit-Markierung, eine dokumentierte
  Ablöseversion und einen Entfernungstermin. Nach Ablauf wird der Alias mit
  einer klaren Validierungsfehlermeldung abgewiesen.
- Bestehende UUIDs werden bei Migrationen unverändert übernommen. Wenn eine
  Alfa-Entität keinen UUID-Schlüssel besitzt, muss die konkrete Konvertierung
  vor dem Import festgelegt und auf Kollisionen geprüft werden; Schritt 1
  führt diese Konvertierung nicht aus.

## Folgerisiken für Phase 1, Schritte 2–5

1. **Schritt 2 – Runner/Baseline:** Die Zielbasis hat neun
   initdb-orientierte Migrationen, Alfa 41 nummerierte Migrationen mit
   Lücken und Checksummen. Die Baseline muss die hier festgelegten Owner,
   UUIDs und Permission-Keys referenzieren, ohne bestehende Dateien
   umzuschreiben.
2. **Schritt 3 – RLS/FORCE RLS/FKs:** Alfa erzwingt Composite-Tenant-FKs
   und request-scope-basierte RLS. Jede gemappte Beziehung, insbesondere
   Site-, Patrol-, Incident- und Notification-Beziehungen, muss auf
   gleiches `tenant_id` geprüft werden; ein bloßes Tabellen-Mapping reicht
   nicht.
3. **Schritt 4 – Granulares RBAC:** Die Zielcodes sind tenant-weit und
   `admin`/`operator`/`viewer` sind grobe Rollen. Alfa-Scope darf nicht
   durch Rollen-Namen ersetzt werden. Die Einführung von Tenant-/Site-/Own-
   Grants muss die oben definierte Code-Stabilität und die bestehende
   Viewer-/Operator-Kompatibilität bewahren.
4. **Schritt 5 – Sessions/Seeds:** Beide Systeme verwenden opaque Sessions
   und CSRF, aber Alfa ergänzt Revocation, Origin-Prüfung und
   Tenant-Auswahl. `sessions` bleibt der Ziel-Owner; Cookie-, Revocation-
   und Seed-Regeln müssen additiv vereinheitlicht werden, ohne UUID- oder
   Permission-Referenzen zu brechen.
5. **Status-/Import-Risiko:** Die Phase-0-Analyse belegt nicht jedes Alfa-
   Statusliteral. Vor einer Datenübernahme sind die tatsächlichen Alfa-
   Constraints, Codes und UUID-Formate aus dem Quellstand maschinenlesbar
   zu inventarisieren; unbekannte Werte werden abgewiesen, nicht geraten.
6. **Spätere Module:** Wachbuch, Dienstplanung, DMS, Schlüsselverwaltung und
   SOP besitzen derzeit keinen Ziel-Owner. Ihre späteren ADRs müssen dieses
   Mapping erweitern, dürfen aber `customers`, `employees`, `sites`,
   `incidents`, `shift_handovers` und `audit_events` nicht duplizieren.

## Quellen

- Ziel-Repository: `backend/migrations/001_init.sql`,
  `backend/migrations/003_sessions_permissions_alarms.sql` bis
  `backend/migrations/009_phase8_mobile_sync.sql`,
  `backend/src/entities/index.ts`, `backend/src/types/models.ts`,
  `backend/src/routes/crud.ts` und `backend/src/routes/phase2.ts` bis
  `backend/src/routes/phase8.ts`.
- Phase-0-Merge-Analyse: dokumentierte Alfa-Migrations-/Modulaufnahme mit
  `001_initial_schema.sql`, Migrationen `001`–`043`, `runner.ts`,
  `authorizationScopes.ts`, `034_system_wide_data_scope.sql` und
  `043_alfasecuritysoft_app_user.sql`.
