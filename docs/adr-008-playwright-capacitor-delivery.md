# ADR-008: E2E- und Android-Auslieferung

## Entscheidung

Playwright wird als Root-Workspace-Test mit `baseURL` auf Vite (`5173`)
konfiguriert. Die beiden Dev-Server werden durch `playwright.config.ts`
gestartet; PostgreSQL 16 bleibt eine explizite lokale/CI-Voraussetzung, damit
die Tests gegen die echte Authentifizierung und die echten tenant-scoped
Alarm-/Report-Endpunkte laufen.

Die mobile Web-App wird mit Capacitor als Android-Projekt erzeugt. `webDir`
zeigt auf `frontend/dist`, App-ID und Name sind `de.example.securityops` und
`SecurityOps`. Die bestehenden IndexedDB-, Service-Worker- und Manifest-
Funktionen werden unverändert in die WebView übernommen.

## Grenzen

Hardware-NFC und BLE werden nicht vorgetäuscht. Die aktuelle mobile Oberfläche
verwendet eine eingegebene bzw. gescannte Kennung und synchronisiert über die
bestehende Offline-Outbox. Native Plugins können in einem separaten, geräte-
und Datenschutz-geprüften Schritt ergänzt werden.

## Verifikation

Der Seed für `admin@example.com` ist ein echter Argon2id-Hash für `password`;
`backend/tests/seed-auth.test.ts` verifiziert diesen Hash. Playwright prüft
Login, Cookies, NSL-Dashboard, Panic-/Lifecycle- und Report-Flows. Der
Android-Build wird über `npm run android:debug` ausgeführt.
