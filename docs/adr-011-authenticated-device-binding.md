# ADR-011: Gerätebindung und Widerruf

## Entscheidung

Jede erfolgreiche Anmeldung benötigt eine im Client erzeugte UUID (`device_id`).
Der Server bestimmt den Tenant ausschließlich über die verifizierte
Benutzeridentität und registriert die UUID dort als `devices.device_kind =
'authenticated'`. Er speichert nur die begrenzten Metadaten `platform` und
`app_version`; Browser-Fingerprints, IP-Adressen und Geheimnisse gehören nicht
zur Geräteidentität. Jede Session enthält eine tenant-scoped `device_id`.

Ein Gerätewiderruf setzt `devices.revoked_at` und setzt in derselben
PostgreSQL-Transaktion `revoked_at` für alle zugehörigen aktiven Sessions.
Auth-Middleware und damit auch Offline-Sync akzeptieren nur nicht widerrufene,
ablaufende Sessions mit nicht widerrufenem Auth-Gerät.

## Grenzen des Gerätevertrauens

Die UUID ist eine datensparsame Installationskennung, kein Hardware-Nachweis
und kein zweiter Faktor. Sie kann gelöscht, kopiert oder durch einen anderen
Client ersetzt werden. Gerätebindung verhindert daher keine Kontoübernahme bei
gestohlenen Zugangsdaten; sie ermöglicht kontrollierte Session-Verwaltung,
Widerruf und Auditierbarkeit ohne übermäßiges Tracking.

## PostgreSQL-Voraussetzungen

Erforderlich sind PostgreSQL mit `pgcrypto`, aktivierter und erzwungener RLS
aus Phase 1, die Composite-FKs aus Migration 010 und die additive Migration
`014_authenticated_devices.sql`. Ein Upgrade widerruft nicht gebundene
Alt-Sessions effektiv, weil die Middleware nur noch device-bound Sessions
akzeptiert.
