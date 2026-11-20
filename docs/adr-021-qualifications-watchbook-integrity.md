# ADR-021: Qualifikationsverwaltung und Wachbuch-Integrität

## Status

Accepted.

## Entscheidung

Die bestehende Tabelle `employee_qualifications` bleibt die einzige Quelle für
Mitarbeiter-Qualifikationen und wird nicht dupliziert. Ein tenant-scoped
`qualification_catalog` beschreibt Codes, Bezeichnungen und optionale
Standardgültigkeiten. `qualification_reminder_settings` speichert die
konfigurierbaren Vorlauftage (Standard: 90, 60, 30, 7). Der tägliche Worker
stellt ein dedupliziertes Notification-Event über die vorhandenen E-Mail-, SMS-
und In-App-Kanäle ein; der Nachrichtentext enthält keine Secrets.

Neue Wachbuch-Einträge und Revisionen erhalten einen SHA-256-Content-Hash und
einen Hash aus Inhalt plus Vorgänger. Die optional gesetzte Umgebungsvariable
`WATCHBOOK_HASH_SECRET` ergänzt einen HMAC. Die Integritätsprüfung vergleicht
die gesamte tenant-scoped Kette, meldet manipulierte oder unvollständige
Datensätze und gibt keine Hashwerte an die Oberfläche zurück.

## Grenzen

Die Funktion ist eine technische Manipulationserkennung und keine rechtliche
oder zertifizierungsbezogene Aussage. Alte Datensätze ohne Integritätsfelder
werden als nicht prüfbar gemeldet und müssen bei einer Datenmigration bewusst
behandelt werden.
