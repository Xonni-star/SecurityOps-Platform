# NFC-Austausch: Bestätigung an den Vorgang binden

## Problem

Die Bestätigungszustände (`acknowledge_existing`, `acknowledge_restricted`, `replaceConfirmed`)
lagen bisher getrennt vom Austauschformular in den beiden Dialoghost-Seiten. Ein Wechsel des
Ersatzgeräts, des Modus oder einer austauschrelevanten Angabe änderte nur den Formularwert,
ließ die Bestätigungen aber bestehen. Eine für Ersatzgerät A geprüfte Zusammenfassung konnte
damit für Ersatzgerät B übernommen werden.

## Zentrale Lösung

`frontend/src/pages/nfcParts.tsx` ist jetzt die einzige Instanz für:

- `NfcReplaceForm` – vollständiger fachlicher Zustand des Austauschs inklusive Einzelbestätigungen.
- `nfcReplaceSummary(form, oldDevice, candidate)` – Zusammenfassung aus dem aktuellen Zustand
  (alte Kennung/Status/Zuordnung, neue Kennung/Typ/Hersteller/Status/Zuordnung, Grund,
  Übernahmeentscheidung und Folgen für beide Geräte).
- `nfcReplaceSnapshot(form, summary)` – unveränderlicher JSON-Snapshot aus Formular **und**
  Zusammenfassung.
- `updateNfcReplaceForm(current, patch)` – der einzige Change-Weg; setzt bei Geräte-/Moduswechsel
  beide Einzelbestätigungen und bei Änderung der Übernahmeentscheidung die
  Zuordnungsbestätigung zurück.
- `nfcReplaceIsConfirmed(...)` – die Bestätigung gilt nur, wenn der aktuelle Snapshot exakt dem
  gespeicherten Snapshot entspricht.
- `validateNfcReplace` und `nfcReplacePayload` – gemeinsame Validierung und Payload für
  `NfcDevices.tsx` und `NfcDeviceFile.tsx`.

Beide Dialoghost-Seiten rufen bei **jeder** relevanten Änderung `changeReplacement(...)` auf; dies
setzt zusätzlich immer den gespeicherten Snapshot zurück. Ein Wechsel zurück zu einem früheren
Ersatzgerät stellt alte Bestätigungen daher nicht wieder her. Vor dem Absenden wird der Snapshot
erneut gegen den aktuellen Zustand geprüft; bei Abweichung blockiert das Frontend den Aufruf mit
„Die Zusammenfassung hat sich geändert. Bitte erneut prüfen und bestätigen.“

### Ungültigmachung (fachlich)

| Änderung | Einzelbestätigungen | Zusammenfassungsbestätigung |
| --- | --- | --- |
| Ersatzgerät A → B / Auswahl entfernt | Zuordnung + Status zurückgesetzt | zurückgesetzt |
| Modus „vorhanden“ ↔ „neu“ | Zuordnung + Status zurückgesetzt | zurückgesetzt |
| Übernahme an/aus | Zuordnungsbestätigung zurückgesetzt | zurückgesetzt |
| Grund, Notizen, Kennung, Hersteller, Gerätetyp | unverändert, soweit fachlich nicht betroffen | zurückgesetzt |
| Bestätigungs-Checkbox selbst | Snapshot wird neu erstellt | neu erteilt |

Ein reines Öffnen/Schließen anderer Dialoge oder harmlose Filteränderungen lösen keinen Reset aus.

## Backend als Sicherheitsgrenze

`POST /api/v1/nfc-devices/:id/replace` bleibt verbindlich für Status-, Rollen-, CSRF- und
Mandantenprüfungen. Die Bestätigungsflags werden zusätzlich an das konkrete Ersatzgerät gebunden:
das Frontend sendet `acknowledged_device_id` im vorhandenen Modus, das Backend verlangt es bei
gesetzten Bestätigungsflags und lehnt eine Abweichung von `new_device_id` mit 409 ab. Audit und
Historie enthalten die gebundene Geräte-ID. Bestehende Sperren (`SELECT … FOR UPDATE`),
Parallel-Request-Schutz, Rollback und Freigaben für zugeordnete bzw. gesperrte Kandidaten bleiben
unverändert aktiv. Bestätigungen ersetzen keine Berechtigung.

## Tests

- `frontend/tests/nfc-devices.test.tsx`: Szenarien A–E plus Geräteakte mit Ersatzgerätewechsel.
- `backend/tests/nfc-management.test.ts`: fehlende/ungültige/veraltete Bestätigung, falsche
  Ersatzgeräte-ID, erfolgreicher gebundener Austausch, Audit-Inhalt.
- `backend/tests/nfc-lifecycle.integration.test.ts`: bestehender Lebenszyklus, Parallel-Requests,
  Rollback und transaktionale Sperren (unverändert, mit Scope-Feld versehen).
