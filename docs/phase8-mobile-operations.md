# Phase 8 Mobile-Betrieb

## Installation und Nutzung

Die Frontend-URL über HTTPS öffnen, anmelden und `/mobile` auf dem Smartphone
zum Startbildschirm hinzufügen. Der Service Worker benötigt HTTPS (localhost ist
für Entwicklung ausgenommen). Große Touch-Ziele, dunkle Browser-/Systemdarstellung
und ein sichtbarer Online-/Offline-Status sind für den Außeneinsatz vorgesehen.

## Offline-Ablauf

Kontrollpunkt-Kennung und Mitarbeiter-ID eingeben bzw. über einen vorhandenen
NFC-/Barcode-Scanner einfügen. Offline gespeicherte Scans und Panikmeldungen
erscheinen in der Outbox. Nach Wiederverbindung synchronisiert die App in
Erstellungsreihenfolge. `synchronisiert` wird nur nach Serverantwort angezeigt;
Konflikte bleiben markiert und müssen in der Leitstelle geprüft werden.

## Push

Für Push muss eine Web-Push-Infrastruktur mit VAPID-Schlüsseln und einem
Delivery-Worker angebunden werden. Der öffentliche Schlüssel darf als
`window.__SECURITYOPS_VAPID_PUBLIC_KEY` injiziert werden; der private Schlüssel
bleibt ausschließlich im Push-Provider. Ohne diese Konfiguration zeigt die App
Push als nicht konfiguriert und fällt nicht still auf eine Erfolgsmeldung zurück.
