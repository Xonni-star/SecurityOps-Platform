# Phase 4, Schritt 13f: Hardware-Abnahme NFC/BLE

## Status

**OPEN – keine Hardware-Szenarien wurden als PASS dokumentiert.**

Die Abnahme darf nur mit einem tatsächlich verbundenen Zielgerät, einem
nachweislich vorhandenen NFC-Tag/Reader bzw. einer BLE-Peripherie, der zu
prüfenden App und einer erreichbaren isolierten Backend-/Testumgebung
durchgeführt werden. Browser-E2E oder Mock-/Fixture-Daten ersetzen diesen
Nachweis nicht.

## Vorprüfung dieses Laufs

Ausgeführt am 2026-11-20 im Branch `xonni-star-phase-4-hardware-abnahme`:

| Voraussetzung | Beobachtung | Ergebnis |
|---|---|---|
| Android-Tooling | `adb` und `fastboot` sind unter `/usr/local/bin` vorhanden | OPEN |
| Android-Zielgerät | `adb devices -l` meldet nur die Geräteüberschrift; kein Gerät ist autorisiert/verbunden | OPEN |
| USB-/APK-Nachweis | `system_profiler SPUSBDataType` liefert keinen angeschlossenen Zielgerät-/Reader-Nachweis; keine APK ist im Repository vorhanden | OPEN |
| Backend/Testumgebung | `docker compose ps` scheitert, weil der Docker-Daemon nicht erreichbar ist | OPEN |
| Capacitor-Android | Keine `android/`, `capacitor.config.*` oder APK-Datei ist im Repository vorhanden | OPEN |
| NFC/BLE-App-Pfad | Es gibt NFC-Inventarverwaltung und einen serverseitigen `nfc_uid`-Scanvertrag, aber keinen nativen NFC-/BLE-Scanner und keinen BLE-Verbindungspfad | OPEN |

Damit wurden **keine** NFC-, BLE-, Offline-Sync- oder Widerrufsszenarien
ausgeführt. Insbesondere gibt es keinen zulässigen Hardware-PASS aus diesem
Lauf.

## Implementierungsbefund und Sicherheitsgrenzen

- Die PWA nimmt im mobilen Kontrollgang derzeit eine Kontrollpunktkennung
  entgegen; `POST /patrol-routes/:routeId/scans` validiert den `nfc_uid`
  tenant-gebunden, prüft die Routenzuordnung und erkennt
  `out_of_order`-Scans.
- Die Offline-Outbox liegt in IndexedDB und verschlüsselt den Payload mit
  Web-Crypto AES-GCM. Ein Eintrag wird erst nach einer erfolgreichen
  Serverantwort gelöscht; HTTP 409 bleibt als Konflikt sichtbar.
- Die Gerätebindung verwendet eine clientseitige Installations-UUID. Sie ist
  kein Hardware-Nachweis und kein zweiter Faktor. Ein Widerruf setzt Gerät und
  aktive Sessions serverseitig in einer Transaktion außer Kraft; danach darf
  auch Offline-Sync nicht mehr authentifizieren.
- NFC- und BLE-Erkennung, Pairing, Berechtigungsdialoge, Reader-Varianten,
  BLE-Verbindungsabbruch und native Android-Lifecycle-/Permission-Verhalten
  sind im aktuellen Quellstand nicht implementiert und daher nicht abnahmefähig.

## Manuelles Hardware-Gate

### Benötigte, zu inventarisierende Fixtures

Vor dem Lauf müssen Modell/Seriennummer oder Inventarnummer, OS-Version,
App-/APK-Version, Backend-URL, Test-Tenant und die verwendeten Test-IDs im
Abnahmeprotokoll stehen. Keine Zugangsdaten, Session-Cookies, privaten
Schlüssel oder NFC-Geheimnisse in Git oder Artefakten speichern.

Mindestens erforderlich:

1. Android-Gerät mit aktivierbarem NFC und USB-Debugging, autorisiert für ADB.
2. Zwei beschreibbare oder eindeutig inventarisierte NFC-Tags sowie ein
   Reader-/Scanpfad, der die reale Kennung an die App übergibt.
3. BLE-Peripherie mit dokumentierter MAC-/Service-/Characteristic-Identität,
   reproduzierbarem Pairing und absichtlich auslösbarem Verbindungsabbruch.
4. Eine tatsächlich installierbare Capacitor-Android-APK oder, falls nur die
   PWA abgenommen wird, ein Android-Browser mit HTTPS-URL.
5. Isoliertes Backend mit Migrationen, Test-Tenant, Testbenutzer,
   Test-Route/-Kontrollpunkten und serverseitig prüfbaren Quittungen.

### Reproduzierbarer Start

```bash
adb start-server
adb devices -l
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell pm list packages | grep -i securityops
```

Der Lauf ist **OPEN**, wenn `adb devices -l` kein `device` mit passender
Inventarnummer zeigt, das Gerät nicht autorisiert ist, die APK nicht
installiert ist oder Backend und Test-Tenant nicht erreichbar sind.

Für eine isolierte lokale Umgebung sind die vorhandenen Phase-4-Mechanismen zu
verwenden. Credentials bleiben Prozess-/Umgebungsvariablen und werden nicht
protokolliert:

```bash
export DATABASE_URL=postgres://securityops:securityops@127.0.0.1:5432/securityops
docker compose up -d db
until docker compose exec -T db pg_isready -U securityops -d securityops; do sleep 2; done
npm run migrate
```

Danach ist ein eigener Test-Tenant mit Testdaten anzulegen. Fixture-IDs dürfen
nicht aus Produktion übernommen werden.

## Abnahmematrix

Jede Zeile benötigt Zeitstempel, Fixture-ID, Gerät/App-Version, konkrete
Beobachtung und einen Backend-Nachweis. Ohne diese Belege bleibt sie OPEN.

| ID | Szenario | PASS-Kriterium | Laufstatus |
|---|---|---|---|
| NFC-01 | Tag erkennen und Kontrollpunkt zuordnen | Reale Tag-ID wird gelesen, genau dem vorgesehenen Kontrollpunkt zugeordnet und als Scan serverseitig quittiert | OPEN – kein Zielgerät/Tag/Backend |
| NFC-02 | Falscher oder unbekannter Tag | Unbekannte bzw. fremde Tenant-ID wird abgewiesen; kein Scan wird erzeugt | OPEN – kein Zielgerät/Tag/Backend |
| NFC-03 | Wiederholungs-/Reihenfolgeschutz | Derselbe bzw. ein rückwärts laufender Routenpunkt erzeugt keinen stillen Erfolg; Konflikt/Abweichung ist sichtbar | OPEN – kein Zielgerät/Backend |
| BLE-01 | Peripherie erkennen und verbinden | Erwarteter Dienst/Characteristic wird auf der realen Peripherie gefunden und verbunden | OPEN – keine BLE-Peripherie/kein BLE-App-Pfad |
| BLE-02 | Verbindungsabbruch | Strom-/Funkabbruch wird sichtbar erkannt; kein falscher Erfolgsstatus und sichere Wiederaufnahme | OPEN – keine BLE-Peripherie/kein BLE-App-Pfad |
| OFF-01 | Offline-Outbox | Kontrollpunkt-Scan bleibt offline in der Outbox, Payload bleibt lokal verschlüsselt und wird nicht als synchronisiert angezeigt | OPEN – kein laufendes Backend/Testgerät |
| OFF-02 | Wiederverbindung/Quittung | Nach Wiederverbindung wird exakt ein Serverbeleg erzeugt, der Outbox-Eintrag entfernt und ein Replay bleibt idempotent | OPEN – kein laufendes Backend/Testgerät |
| DEV-01 | Widerrufenes Gerät | Nach serverseitigem Widerruf schlagen bestehende Session und anschließender Offline-Sync mit Authentifizierungsfehler fehl | OPEN – kein Zielgerät/laufendes Backend |

## Durchführungsnotizen und Artefakte

Zulässige Artefakte sind ausschließlich aus einem echten Lauf: gekürzte
`adb devices -l`-/App-Versionsausgabe, reproduzierbare Testzeitpunkte,
serverseitige Quittungs-/Audit-IDs und redigierte Screenshots. Nicht zulässig
sind erfundene Logs, simulierte Sensorwerte, Screenshots aus Browser-E2E als
Hardwarebeleg oder Secrets.

Der CI-Workflow bleibt für diese Abnahme ein **manuelles Gate**: Die normalen
Typecheck-, Test-, Build- und Browser-E2E-Jobs dürfen NFC/BLE nicht als
bestanden markieren. Ein späterer Hardware-Lauf muss außerhalb eines
gewöhnlichen Linux-CI-Runners auf den inventarisierten Geräten erfolgen und
dieses Dokument mit den echten Ergebnissen ergänzen; bis dahin bleibt der
Schritt OPEN.

