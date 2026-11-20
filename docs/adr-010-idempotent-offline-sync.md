# ADR-010: Idempotente Offline-Synchronisation

## Entscheidung

Offline-Panik- und Patrol-Mutationen verwenden eine tenant-scoped `sync_receipts`-
Zeile. Der Server bildet aus dem JSON-Payload eine kanonische Darstellung
(rekursiv sortierte Objekt-Schlüssel) und speichert den SHA-256-Hash zusammen mit
Mutation-ID und Aktion. Receipt-Anlage, fachliche Mutation und Response-Speicherung
erfolgen in einer PostgreSQL-Transaktion. Ein Replay mit identischer Mutation-ID,
Aktion und Hash liefert die gespeicherte Antwort ohne zweiten Effekt; ein anderer
Payload oder eine andere Aktion wird mit einem expliziten 409-Fehler abgelehnt.

## Konflikte und Grenzen

Der Vertrag kennt `USE_LOCAL`, `USE_SERVER` und `RECORD_AS_EXCEPTION`; ohne
Angabe gilt `RECORD_AS_EXCEPTION`. Die aktuelle Phase erkennt und persistiert
Replay-/Hash-/Aktionskonflikte, bietet aber noch keine Delta-/Pull-Synchronisation,
Cross-Device-Replikation oder garantiert zuverlässige Background-Synchronisation.
Die verschlüsselte IndexedDB-Outbox löscht einen Eintrag ausschließlich nach
einer erfolgreichen Server-Quittung.

## PostgreSQL-Voraussetzungen

Erforderlich sind PostgreSQL mit `pgcrypto` (für UUIDs), aktivierter RLS-Konfiguration
aus Phase 1 und die additive Migration `013_offline_sync_receipts.sql`.
