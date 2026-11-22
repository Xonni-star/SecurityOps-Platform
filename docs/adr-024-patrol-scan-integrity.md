# ADR-024: Integrität von NFC-Kontrollscans

## Ist-Lücke

Der bisherige Scan-Endpunkt prüfte Tenant, NFC-UID und die Zugehörigkeit des Kontrollpunkts zur Route. Er prüfte jedoch weder eine aktive NFC-Tag-Registrierung am Kontrollpunkt noch eine zeitlich gültige Mitarbeiter-Zuweisung. Außerdem fehlten Server-Empfangszeit, Tag-Referenz und eine eigene Auditspur. Damit konnte ein berechtigter API-Nutzer einen beliebigen Mitarbeiter für eine Route melden und eine veraltete oder umgebundene UID als Kontrollnachweis einreichen.

## Umgesetzter Schritt

`POST /patrol-routes/{routeId}/scans` verlangt jetzt:

- eine registrierte, aktive `nfc_devices`-Zeile mit `device_type = 'tag'`;
- die Bindung dieses Tags an genau den gescannten Kontrollpunkt und dessen Objekt;
- eine `patrol_assignments`-Zeile für den Mitarbeiter, die den Scanzeitpunkt abdeckt;
- weiterhin Tenant-, Routen- und Kontrollpunkt-Isolation sowie idempotente Mutation-IDs.

Jeder Scan speichert zusätzlich `server_received_at`, `nfc_device_id` und `scan_authentication`. Die Auditspur `patrol.scan.recorded` enthält die Zuordnung und beide Zeitstempel. Ein UID-Scan ist ausdrücklich nur `uid_registered`; ohne kryptografische Tag-Authentifizierung darf er nicht als manipulationssicherer Echtheitsnachweis gelten.

## Bewusst offen

- Kryptografisch authentifizierte Tags (z. B. DESFire mit Backend-verifizierter Challenge/Response) sind nicht implementiert.
- Gerätekennung, Standortnachweis, Pflichtfragen, Fotos, vollständige Offline-Konfliktauflösung und automatische Kontrollrunden fehlen weiterhin.
- Physische NFC-Hardwaretests bleiben nicht verifiziert, wenn kein kompatibles Gerät und kein authentifizierter Tag verfügbar sind.
