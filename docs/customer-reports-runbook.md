# Kundenberichte und Nachweise

`/customer-reports/:kind` exportiert tenant- und objektbezogene Kontrollgänge,
Wachbuch, Alarme und Einsätze als CSV oder PDF. Zeitraum, Objekt und
Dokumentationsprofil werden im Audit protokolliert. Das optionale
`/customer-portal/:kind` ist read-only und nutzt dieselben Objektberechtigungen.

Interne Notizen, Secrets und Daten anderer Mandanten werden nicht exportiert.
`DIN-77200` bezeichnet ausschließlich das verwendete Dokumentationsprofil und
ist keine Rechts-, Zertifizierungs- oder Konformitätsaussage. Vor produktiver
Freigabe sind erlaubte Objekte, Portalrollen und ein Testexport ohne Daten zu
prüfen.
