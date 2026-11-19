# ADR-006: Betriebsreife und kontrollierter Produktions-Rollout

## Entscheidung

Produktionsbetrieb erfolgt getrennt von Staging über Docker Compose, einen
TLS-fähigen Reverse-Proxy, injizierte Secrets, PostgreSQL-Backups und
Readiness-/Restore-Prüfungen. CI validiert jeden Commit; Deployment in die
Umgebungen ist ein expliziter, freigegebener Schritt.

## Begründung

Die Plattform benötigt nachvollziehbare Rollbacks, tenant-sichere Betriebsdaten,
regelmäßige Restore-Nachweise und eine klare Trennung zwischen fachlichen Alarmen
und technischen Bereitschaftsproblemen. `/health` bleibt ein Prozesscheck,
`/ready` prüft zusätzlich die Datenbank.

## Konsequenzen

TLS, Secret-Management, Off-site-Verschlüsselung, Monitoring-Zielsystem,
Dienstleisterverträge und rechtliche Retention-Freigaben müssen vor dem Go-live
konkret durch den Betreiber eingerichtet und abgenommen werden.
