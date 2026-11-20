# ADR-016: Phase 3, step 12 shift handover protocols

## Decision

Schichtübergaben werden als tenant-scoped `handover_records` mit verpflichtendem
Standort und optionaler Dienstplan-Schicht geführt. Teilnehmer werden über genau
eine bestehende User- oder Employee-UUID gebunden; Namen und Kontaktdaten werden
nicht dupliziert. Site-scoped Grants begrenzen Lesen und Bearbeiten. Die
Bestätigung ist für nicht privilegierte Nutzer nur für die eigene User-Bindung
zulässig.

`handover_events` und `handover_confirmations` sind append-only und enthalten
Actor, Session, Gerät, Zeit sowie eine SHA-256-Kette. Korrekturen und Widerrufe
werden als neue Ereignisse bzw. neue Bestätigungszeilen aufgezeichnet. Ein
Handover wird erst als `confirmed` markiert, wenn alle aktiven Teilnehmer eine
aktuelle Bestätigung haben; ein Widerruf öffnet den Status wieder.

Alle Offline-Mutationen verwenden `sync_receipts` und die vorhandene kanonische
Payload-Prüfung. Wiederholungen mit identischem Payload liefern die gespeicherte
Antwort, Hash-/Aktionsabweichungen werden abgelehnt. Eine Mutation gilt erst nach
Serverquittung als abgeschlossen. Widerrufene Geräte scheitern bereits bei der
bestehenden Session-Prüfung.

Aufgaben und Anhänge werden nicht in einer parallelen Übergabe-API gespeichert.
Verweise müssen über die bestehenden autorisierten Dienstplan-, Wachbuch- oder
DMS-Verträge erfolgen; ein Delta-/Pull- oder Cross-Device-Sync ist nicht Teil
dieses Schritts.

## Retention and GDPR

Die Historie ist für Nachvollziehbarkeit append-only. Eine Löschung oder
Anonymisierung darf nur über eine separat freigegebene, dokumentierte
Retention-/DSGVO-Policy erfolgen; Schritt 12 bietet keine stille Löschung,
keine Änderung historischer Ereignisse und keine automatische Aufbewahrungsfrist.
Personenbezug bleibt auf tenant-scoped UUID-Referenzen und die für die
Beweiskette erforderlichen Session-/Gerätebezüge begrenzt.

## Open limits

Es gibt keinen Delta-Feed, keinen Pull-Sync und keine automatische
Cross-Device-Konfliktauflösung. Konflikte werden über die bestehenden
Idempotenz-/Hash-Fehler sichtbar gemacht und müssen durch eine neue, autorisierte
Mutation korrigiert werden.
