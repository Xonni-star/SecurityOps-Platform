# Phase 7 Betriebshandbuch

## Verantwortlichkeiten

Der Betriebsverantwortliche genehmigt Releases, der technische Bereitschaftsdienst
überwacht Verfügbarkeit und Backups, und der fachliche Leitstellenverantwortliche
führt UAT und Alarmierungsproben durch. Bei einem Sicherheitsvorfall wird unverzüglich
der Sicherheitsverantwortliche eingebunden; Datenschutzvorfälle werden an die
zuständige Datenschutzrolle eskaliert.

## Umgebungen und Secrets

Staging und Produktion verwenden getrennte Datenbanken, Domains, Cookies und
Secret-Sätze. Secrets werden ausschließlich über den Deployment-Secret-Store bzw.
`.env.production` außerhalb des Repositories injiziert. Erforderlich sind mindestens
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `CORS_ORIGIN`, `MFA_ENCRYPTION_KEY`,
`KEY_QR_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` sowie die jeweils
aktivierten SMTP-, SMS- und TimeScan-Secrets. Während einer QR-Schlüsselrotation
kommt `KEY_QR_SECRET_PREVIOUS` für maximal 15 Minuten hinzu; der Ablauf steht in
[`key-qr-rotation.md`](key-qr-rotation.md).

## Deployment

1. In Staging aus dem zu veröffentlichenden Commit bauen und CI erfolgreich abwarten.
2. Datenbankmigrationen in einem Wartungsfenster anwenden; die Init-Mounts sind für
   Erstinstallation, nicht für laufende Migrationen gedacht.
3. Produktions-Compose starten:
   `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`
4. `curl --fail https://<domain>/ready` und `curl --fail https://<domain>/ready/dms`
   sowie die WebSocket-Verbindung prüfen. `/ready/dms` meldet nur `ready`, wenn
   MinIO-Bucket und ClamAV erreichbar sind.
5. UAT-Smoke-Szenario aus `docs/phase7-uat-checklist.md` durchführen.

Der Workflow `.github/workflows/deploy.yml` deployt manuell nach Staging oder
Produktion und bei einem `v*`-Tag nach Produktion. GitHub-Environment-Secrets
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`,
`DEPLOY_PATH` und `DEPLOY_ENV_FILE` sind je Umgebung getrennt zu hinterlegen.
`DEPLOY_KNOWN_HOSTS` enthält den verifizierten öffentlichen Host-Key des Servers;
die Workflow-Datei ersetzt keine Freigabe- oder TLS-Konfiguration.

## Stop, Update, Rollback

`docker compose -f docker-compose.production.yml stop` hält die Anwendung an.
Vor Updates einen verschlüsselten Backup-Lauf durchführen. Ein Update wird durch
den neuen, geprüften Commit gebaut und mit `up -d --build` aktiviert. Bei Fehlern
den vorherigen Images/Commit deployen, nicht die Datenbank rückwärts migrieren;
bei inkompatiblen Migrationen den dokumentierten Restore-Drill verwenden.

## Monitoring und Alarmierung

Reverse-Proxy-Uptime prüft `/health`, Readiness prüft `/ready`. HTTP-Logs werden
zentral gesammelt; Alarmgrenzen sind: drei fehlgeschlagene Readiness-Prüfungen,
5xx-Rate über 2 % in fünf Minuten, Backup älter als 26 Stunden oder fehlgeschlagener
Restore-Drill. PostgreSQL- und Container-Restarts werden ebenfalls alarmiert.
Die Benachrichtigung erfolgt über den Bereitschaftsdienst, nicht über die
fachliche Alarm-Outbox.

## Backup und Restore

`scripts/backup-db.sh` erstellt Custom-Format-Dumps. Backups werden verschlüsselt,
off-site repliziert und mit einer Aufbewahrung gemäß Retention-Policy versehen.
Wöchentlich wird der reproduzierbare isolierte PostgreSQL-plus-MinIO-Drill mit
`scripts/restore-drill.sh` ausgeführt; er darf nur mit
`RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES=YES` auf Testressourcen laufen. Der
Nachweis enthält UTC-Zeitstempel, Backup-/Restore-Dauer, RPO/RTO, Tenant-Isolation,
DMS-Metadaten/Blob-Verknüpfungen, Retention und Hashes. Fehlende Infrastruktur
wird als OFFEN dokumentiert. Ein Restore in Produktion erfolgt nur nach Freigabe
und Wartungsfenster.

## Incident Response

1. Incident-ID, Beginn, betroffene Umgebung und letzte erfolgreiche Readiness-Prüfung
   erfassen.
2. Verfügbarkeit stabilisieren (Rollback, Isolation oder Read-only-Maßnahme).
3. Logs, Audit-Events und Backup-Status sichern; keine personenbezogenen Daten in
   externe Tickets kopieren.
4. Sicherheits-, Datenschutz- und fachliche Verantwortliche nach Auswirkung eskalieren.
5. Nach Wiederherstellung Ursache, Maßnahmen und Preventive Actions dokumentieren.
