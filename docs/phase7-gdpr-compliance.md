# Phase 7 Datenschutz- und Compliance-Betriebsdokumentation

## Verarbeitungstätigkeiten

Die Plattform verarbeitet Identitäts-, Beschäftigten-, Alarm-, Einsatz-, Positions-,
Telemetrie-, Kommunikations- und Kontrollgangdaten zur Durchführung und
Nachvollziehbarkeit beauftragter Sicherheitsdienstleistungen. Zweck, Tenant,
Zugriffsrolle und Aufbewahrung werden je Verarbeitung dokumentiert; nicht benötigte
Daten werden nicht erhoben.

## Rollen und Auftragsverarbeitung

Verantwortlicher, Auftragsverarbeiter, Unterauftragsverarbeiter, Hostingstandort,
Drittlandtransfer und technische Schutzmaßnahmen werden je Betreiber in einem
separaten AVV-/Dienstleisterverzeichnis gepflegt. Diese Datei ist eine
Dokumentationsvorlage und keine Rechts- oder Zertifizierungsaussage.

## Betroffenenrechte und Löschung

Auskunft wird tenant-scoped über den Data-Subject-Export erstellt und vor Übergabe
manuell auf Identität, Zweck und Empfänger geprüft. Lösch- oder
Anonymisierungsanträge werden mit Rechtsgrund, Umfang, Ausnahmen wegen gesetzlicher
Nachweispflichten und Abschlussdatum protokolliert. Retention-Jobs löschen oder
anonymisieren Telemetrie-, Positions-, Kommunikations- und Auditdaten nur gemäß
freigegebener Policy.

## Schutzmaßnahmen

TLS am Reverse-Proxy, verschlüsselte/off-site Backups, Secret-Store, Least-Privilege,
Tenant-Prädikate, CSRF, Rate-Limits, Auditierung und regelmäßige Restore-/Zugriffs-
prüfungen sind verpflichtende Betriebsmaßnahmen. Datenschutzverletzungen werden
sofort bewertet und nach dem internen Meldeprozess eskaliert.

## Fachlicher Bezugsrahmen

Prozessbeschreibungen können sich an den Anforderungen der DIN 77200 und § 34a
GewO orientieren. Daraus wird ausdrücklich keine Rechtsberatung, Konformitäts- oder
Zertifizierungsaussage abgeleitet; die rechtliche Prüfung erfolgt durch den Betreiber.
