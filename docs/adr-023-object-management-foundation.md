# ADR-023: Objektmanagement-Fundament und CRM-Verknüpfung

## Status

Akzeptiert als erster inkrementeller Umsetzungsschritt auf dem CRM-Grundlagenbranch.

## Bestandsaufnahme und Priorisierung

Der Bestand enthält bereits tenant-isolierte Sites, Kunden, Verträge und `customer_sites` sowie operative Module für Patrols, Schlüssel, Alarme/Incidents, DMS, Wachbuch/Übergaben, Qualifikationen, Dienstplanung und Benachrichtigungen. Diese Module verfügen überwiegend über Backend, UI und Tests, sind aber noch nicht als konsistente Objektakte verbunden. Sites und Kunden werden aktuell nur über generische Minimalformulare gepflegt; die CRM-Beziehungen besitzen keine nutzbare Objekt-Workflow-API.

P0 ist die Autorisierung im generischen CRUD: Site-scoped Updates wurden für Sites pauschal blockiert, und Own-scoped Creates hatten keinen belastbaren Ownership-Anker. Das gefährdet sichere Weiterentwicklung der Objektakte. P1 sind reichhaltige Objektstammdaten und sichere Kunden-/Vertragsbeziehungen; P1 folgen Risiko-, Alarmplan-, Personal-/Qualifikations- und Journalintegration. P2 sind Gebäudehierarchie, Anlagen, Besucher, Kalender und erweiterte Integrationen.

## Entscheidung

Die bestehende `sites`-Tabelle bleibt der kanonische Objektstammdatensatz. Migration 034 ergänzt additive Stammdaten, Status-/Koordinaten-Constraints und tenant-gebundene Verantwortliche. Kunden- und Vertragsbeziehungen bleiben in `customer_sites` und `contract_sites`; es wird kein paralleles Objekt- oder CRM-Modell eingeführt.

Eine geschützte Object-Context-API liefert Site, verknüpfte Kunden und Verträge. Kundenverknüpfungen werden tenant-seitig validiert, archiviert statt gelöscht und auditierbar geschrieben. Die bestehende RLS- und Permission-Schicht bleibt maßgeblich; Frontend-Berechtigungen sind nur UX.

## Risiken und Folgearbeiten

Statusübergänge werden im CRUD validiert, um inkonsistente operative Zustände zu vermeiden. Sensitive Inhalte wie Schlüssel, Alarmpläne und Dokumente bleiben in ihren bestehenden, separat berechtigten Modulen. Als nächstes folgen eine dedizierte Objektakte mit Gebäude/Bereichen und die Verknüpfung von Journal, Risiken und operativen Kennzahlen.
