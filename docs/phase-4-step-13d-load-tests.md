# Phase 4, Schritt 13d: reproduzierbare Lasttests

Der isolierte Harness liegt in `backend/src/loadtest.ts` und verwendet ausschließlich die
bestehenden authentifizierten Contracts:

* **Alarm-Ingest:** `POST /api/v1/alarms` mit `alarms:write`, tenantgebundener
  `priority_id`, eindeutiger `client_event_id` und CSRF-Schutz.
* **WebSocket-Fanout:** authentifizierte Sessions auf `/ws`; gezählt werden nur
  `alarm.created`-Frames mit der aktuellen, eindeutigen Run-ID.
* **Report-Export:** `GET /api/v1/reports/alarms?format=csv|pdf` mit
  `reports:read`.

Der Harness schreibt ein JSON-Ergebnis nach `LOADTEST_OUTPUT` (Standard:
`loadtest-results/<timestamp>.json`) und druckt dasselbe Ergebnis aus. Ohne
erfolgreiche `/ready`-Prüfung, gültige isolierte Fixture-Credentials oder
ausdrücklich angeforderte Zusatzinfrastruktur werden keine Phasen ausgeführt und
der Status bleibt `OPEN`. Ein nicht gestarteter Lauf ist daher kein Pass.

## Ausführung

Nur gegen eine isolierte Umgebung ausführen, niemals gegen Produktionsdaten:

```bash
export LOADTEST_FIXTURE=isolated
export LOADTEST_EMAIL=loadtest@example.invalid
export LOADTEST_PASSWORD='a-local-only-password'
export LOADTEST_TENANT_NAME=loadtest-phase-4
export DATABASE_URL=postgres://securityops:securityops@127.0.0.1:5432/securityops
npm run migrate
npm run loadtest:fixture
```

Die Fixture-Ausgabe liefert `deviceId` und `priorityId`; diese Werte werden als
`LOADTEST_DEVICE_ID` und `LOADTEST_PRIORITY_ID` gesetzt. Danach:

```bash
export LOADTEST_BASE_URL=http://127.0.0.1:3000
export LOADTEST_CLIENTS=10
export LOADTEST_RPS=10
export LOADTEST_DURATION_SECONDS=10
export LOADTEST_FANOUT_EVENTS=10
export LOADTEST_EXPORTS=3
export LOADTEST_REQUIRED_INFRA=postgres
npm run loadtest
```

Die Last ist konfigurierbar, aber immer explizit: Clients, RPS, Dauer, Fanout-
Eventanzahl, Exportanzahl und Request-Timeout werden im Ergebnis dokumentiert.
Gemessen werden pro Phase Anzahl, Fehlerquote, p50/p95/p99, Min/Max,
Durchsatz; der WS-Test misst zusätzlich erwartete/gelieferte Frames und
Fanout-Lieferquote. Der Export weist Dauer, Fehler und Antwortbytes aus.

Baseline-Kriterien sind standardmäßig strikt: keine Fehler, mindestens die
konfigurierte Rate und 100% Fanout-Lieferquote. Sie können mit
`LOADTEST_MAX_ERROR_RATE`, `LOADTEST_MIN_THROUGHPUT_RPS`,
`LOADTEST_MIN_FANOUT_DELIVERY_RATE` und `LOADTEST_MAX_P95_MS` gesetzt werden.
Ein Wert von `0` bei `LOADTEST_MAX_P95_MS` deaktiviert nur dieses Kriterium.

## Umgebungsparameter und Grenzen

Das Ergebnis enthält Node-Version, Betriebssystem, Architektur, Ziel-URL und
alle Lastparameter. Hardware- und Containerdaten kommen aus dem CI-Runner und
müssen zusammen mit dem JSON-Ergebnis aufbewahrt werden; lokal ist mindestens
CPU/Architektur, RAM, PostgreSQL-Version, Docker-Version und Netzwerktopologie
zu notieren. Der Harness behauptet keine Redis- oder Provider-Leistung: diese
Abhängigkeiten sind für die aktuellen drei Pfade nicht im Contract. Werden sie
über `LOADTEST_REQUIRED_INFRA=redis,provider` als erforderlich markiert, fehlen
`LOADTEST_REDIS_URL` oder `LOADTEST_PROVIDER_HEALTH_URL` bzw. schlägt der
Healthcheck fehl, bleibt der Lauf `OPEN`.

Die Fanout-Implementierung ist derzeit ein Prozess-interner Client-Satz; der
Test ist deshalb keine Aussage über horizontales WS-Fanout über mehrere
Backend-Instanzen. Die Reports sind auf 5.000 Alarme begrenzt, wie der
Produktions-Contract vorgibt. Fixtures verwenden einen Tenant-Namen mit
`loadtest-`, feste nicht-produktive UUIDs und werden nur bei
`LOADTEST_FIXTURE=isolated` und außerhalb von `NODE_ENV=production` angelegt.
