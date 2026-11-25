# ADR-023: Objektmanagement-Fundament und CRM-Verknüpfung

## Status

Akzeptiert als erster inkrementeller Umsetzungsschritt auf dem CRM-Grundlagenbranch.

## Bestandsaufnahme und Priorisierung

Der Bestand enthält bereits tenant-isolierte Sites, Kunden, Verträge und `customer_sites` sowie operative Module für Patrols, Schlüssel, Alarme/Incidents, DMS, Wachbuch/Übergaben, Qualifikationen, Dienstplanung und Benachrichtigungen. Diese Module verfügen überwiegend über Backend, UI und Tests, sind aber noch nicht als konsistente Objektakte verbunden. Sites und Kunden werden aktuell nur über generische Minimalformulare gepflegt; die CRM-Beziehungen besitzen keine nutzbare Objekt-Workflow-API.

P0 ist die Autorisierung im generischen CRUD: Site-scoped Updates wurden für Sites pauschal blockiert, und Own-scoped Creates hatten keinen belastbaren Ownership-Anker. Das gefährdet sichere Weiterentwicklung der Objektakte. P1 sind reichhaltige Objektstammdaten und sichere Kunden-/Vertragsbeziehungen; P1 folgen Risiko-, Alarmplan-, Personal-/Qualifikations- und Journalintegration. P2 sind Gebäudehierarchie, Anlagen, Besucher, Kalender und erweiterte Integrationen.

## Entscheidung

Die bestehende `sites`-Tabelle bleibt der kanonische Objektstammdatensatz. Migration 034 ergänzt additive Stammdaten, Status-/Koordinaten-Constraints und tenant-gebundene Verantwortliche. Kunden- und Vertragsbeziehungen bleiben in `customer_sites` und `contract_sites`; es wird kein paralleles Objekt- oder CRM-Modell eingeführt.

Eine geschützte Object-Context-API liefert Site, verknüpfte Kunden und Verträge. Kundenverknüpfungen werden tenant-seitig validiert, archiviert statt gelöscht und auditierbar geschrieben. Die bestehende RLS- und Permission-Schicht bleibt maßgeblich; Frontend-Berechtigungen sind nur UX.

Der Objektkontext prüft zusätzlich den konkreten Site- bzw. Ownership-Scope. Da Kunden- und Vertragsdaten in diesem Kontext nicht einzeln auf engere Scopes gefiltert werden, sind für sie Tenant- oder Systemrechte erforderlich. Das Wachbuchjournal wird nur mit passender `watchbook:read`-Berechtigung zurückgegeben; `journal: null` kennzeichnet fehlende Berechtigung.

Die Objektakte bindet bestehende Personalzuordnungen (`employee_object_assignments`) und laufende bzw. zukünftige Schichten aus der Dienstplanung ein, ohne neue Tabellen oder Kopien anzulegen. Personalnamen und Zuordnungen benötigen zusätzlich `employees:read` für den konkreten Site-Scope; Schichten benötigen `scheduling:read`. Schichtnamen werden nur mit Personal-Leserecht ausgegeben, andernfalls bleibt es bei der Anzahl zugewiesener Kräfte. Abgelaufene Zuordnungen und beendete Schichten werden nicht als aktuelle Planung angezeigt.

Die Objektakte bindet außerdem vorhandene site-verknüpfte Kontrollgangpläne, aktuelle oder zukünftige Personalzuweisungen und die letzten 20 echten NFC-Kontrollpunktscans read-only ein. Der konkrete Site-Scope wird mit `patrols:read` geprüft; ohne passende Berechtigung ist `patrols: null`, eine berechtigte leere Ergebnismenge ist dagegen explizit leer. Mitarbeiternamen erscheinen nur zusätzlich zu einer passenden `employees:read`-Berechtigung. Es entstehen weder neue Patrol-Daten noch simulierte Läufe oder Aktionen.

Schlüsselbestand, die letzten 20 Schlüsselbewegungen und Schlüsselbunde verwenden getrennte `keys:read`- bzw. `keys:bundle_read`-Site-Berechtigungen. DMS-Dokumente und Versionen kommen aus den vorhandenen DMS-Tabellen; Kundendokumente bleiben ohne `customer_documents:read` ausgeblendet. Upload und Download laufen ausschließlich über die vorhandenen, serverseitig geprüften DMS-Endpunkte. Die Objektakte legt keine parallelen Schlüssel- oder Dokumentdaten an.

## Risiken und Folgearbeiten

Statusübergänge werden im CRUD validiert, um inkonsistente operative Zustände zu vermeiden. Schlüsselaktionen und DMS-Lebenszyklus bleiben in ihren bestehenden, separat berechtigten Modulen. Weitere Objektakten-Integrationen umfassen Alarm-/Vorfallsdaten, Qualifikationen, Übergaben, Aufgaben und Wartung.
