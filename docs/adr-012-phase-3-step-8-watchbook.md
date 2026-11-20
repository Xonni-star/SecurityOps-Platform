# ADR-012: Digitales Wachbuch (Phase 3, Schritt 8)

Das Wachbuch wird als tenant-scoped, append-only Fachmodell eingeführt. Kategorien und Prioritäten sind tenantbezogene Stammdaten. Ein Eintrag besitzt eine unveränderliche Identität; jede fachliche Änderung wird als neue Revision mit fortlaufender Nummer, Korrekturbezug, Autor, authentifizierter Session und – sofern vorhanden – Gerät gespeichert. Revisionen können weder aktualisiert noch gelöscht werden.

## API und Offline-Grenzen

- `GET /api/v1/watchbook/categories`, `GET /api/v1/watchbook/priorities`
- `GET /api/v1/watchbook/entries`, `GET /api/v1/watchbook/entries/:id/history`
- `POST /api/v1/watchbook/entries` mit `client_entry_id` oder `Idempotency-Key`
- `POST /api/v1/watchbook/entries/:id/corrections` mit Pflichtbegründung
- Stammdaten: `POST /api/v1/watchbook/categories` und `/priorities` mit administrativer Berechtigung

Offline-Erstellung ist idempotent und nutzt die bestehende Sync-Receipt-Struktur. Es gibt bewusst keinen Delta-/Pull-/Cross-Device-Mechanismus; die Outbox darf nur dieselbe Mutation erneut senden. Replay liefert die gespeicherte Antwort, Payload- oder Aktionsabweichungen werden abgelehnt.

## Retention und Löschung

Wachbuchhistorie ist revisionssicher und nicht über die API löschbar. Aufbewahrung, Export und rechtliche Löschsperren müssen durch eine separate, freigegebene Betriebsrichtlinie umgesetzt werden. Ein Tenant-Löschen entfernt die Daten gemäß FK-Kaskaden; einzelne Einträge bleiben bis dahin vollständig auditierbar.

## Betriebsgrenzen

Jede Anfrage benötigt eine opaque, gerätegebundene Session und die passende Scope-Berechtigung. PostgreSQL-RLS und tenant-komposite Fremdschlüssel verhindern Quer-Tenant-Zugriffe. Ein geschlossener Eintrag kann nicht wieder geöffnet werden; eine Korrektur ist stets eine neue, autor- und sessiongebundene Revision.
