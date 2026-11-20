# Phase 4, Schritt 13e: echte Browser-E2E

Die Playwright-Suite in `e2e/phase4.spec.ts` führt drei reale Szenarien aus:

- Login gegen den laufenden Backend-Contract, inklusive Rollen-/Permission-Prüfung,
  Tenant-gebundenem NSL-Dashboard und MFA-Status des aktuellen Flows.
- Alarm-Erstellung über die API-Fixture und Quittieren/Erledigen im echten Browser.
- Mobile PWA mit aktivem Service Worker, Offline-Outbox, Wiederverbindung und
  serverseitiger Reconciliation der Patrol-Quittung.

Die Suite akzeptiert keinen simulierten Pass. Vor den Tests werden `/ready` und ein
echter Login geprüft. Fehlen Credentials, Backend, Fixture oder MFA-Konfiguration,
bricht der Lauf mit `OPEN` und einer konkreten Startanweisung ab. Traces,
Screenshots, Videos und der HTML-Report werden nur aus diesem tatsächlichen Lauf
unter `e2e-results/` referenziert.

## Isolierter lokaler Lauf

Nur eine lokale, nicht-produktive Umgebung verwenden. Das Passwort wird nicht
committet:

```bash
export E2E_FIXTURE=isolated
export E2E_EMAIL="e2e-$(date +%s)@example.invalid"
export E2E_PASSWORD="$(openssl rand -base64 32)"
export E2E_TENANT_NAME=e2e-phase-4
export DATABASE_URL=postgres://securityops:securityops@127.0.0.1:5432/securityops
docker compose up -d db
until docker compose exec -T db pg_isready -U securityops -d securityops; do sleep 2; done
npm run migrate
npm run e2e:fixture
docker compose up -d --build backend frontend
until curl --fail --silent http://127.0.0.1:3000/ready >/dev/null; do sleep 2; done
until curl --fail --silent http://127.0.0.1:5173/login >/dev/null; do sleep 2; done
npx playwright install chromium
npm run e2e
docker compose down -v
```

In CI erzeugt `.github/workflows/ci.yml` die Credentials pro Lauf, startet
PostgreSQL/Backend/Frontend isoliert und lädt den Playwright-Report sowie echte
Fehlerartefakte als Workflow-Artefakt hoch. Ohne erfolgreich installierten
Chromium-Browser ist der Lauf ebenfalls `OPEN`, nicht bestanden.
