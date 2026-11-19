# ADR-007: Mobile PWA und Offline-Synchronisation

## Entscheidung

Die Wächter-App wird als installierbare PWA im bestehenden React-Frontend
ausgeliefert. Ein Service Worker cached den App-Shell, IndexedDB hält eine
verschlüsselte Outbox, und jede mobile Aktion erhält eine UUID als
`client_event_id`. Der Server erzwingt tenant-scoped Unique-Indizes für mobile
Alarme und Scans.

## Konflikte und Sicherheit

Netzwerkfehler lassen Vorgänge in der Outbox; HTTP-409 und nicht automatisch
auflösbare Fehler bleiben als Konflikt sichtbar. Eine lokale Aktion wird erst
nach einer erfolgreichen Serverantwort als synchronisiert markiert. Die Outbox
wird mit Web Crypto AES-GCM verschlüsselt, es werden keine Session-Secrets oder
Passwörter lokal gespeichert. Push benötigt eine separat betriebene Web-Push-
Zustellung; der Client speichert nur die Browser-Subscription.

## Konsequenzen

Offline-Nutzung ist auf die implementierten Vorgänge (Kontrollpunkt-Scan und
Panikmeldung) begrenzt. Ein serverseitig zugestellter Alarm kann bei vollständig
offline geschlossener App nicht garantiert werden; dafür bleibt die bestehende
NSL-/SMS-/E-Mail-Alarmierung maßgeblich.
