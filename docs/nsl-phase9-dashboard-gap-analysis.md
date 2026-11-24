# NSL Phase 9: Leitstellenübersicht – Gap-Analyse

## Bestand vor diesem Schritt

Die NSL-Leitstelle bündelt bereits offene Alarme, aktive Incidents/Einsätze,
letzte Gerätepositionen und Kontrollgänge. Alarm-, Incident-, Übergabe-,
Audit-, Eskalations-, Dienstplan- und WebSocket-Verträge sind tenant-scoped und
serverseitig berechtigt. Reports und bestehende Alarm-/Incident-Lifecycle-APIs
bleiben unverändert.

Die Startseite zeigte bisher jedoch nur Listenlängen. Für den operativen
Leitstellenbetrieb fehlten belastbare Kennzahlen für unbestätigte, kritische,
quittierte und eskalierte Alarme, aktive Einsätze, gebundene Einsatzkräfte,
offene Übergaben und technische Störungen.

## Umgesetzt

- `/api/v1/nsl/dashboard` liefert zusätzlich tenant-scoped Kennzahlen aus den
  bestehenden Alarm-, Incident-, Dienstplan-, Übergabe- und Geräte-Tabellen.
- Das Frontend zeigt Alarmstatus, operative Lage und Ressourcenstatus an und
  kennzeichnet den Zeitpunkt der letzten Serverantwort.
- Die bestehende WebSocket-Aktualisierung lädt die Kennzahlen bei Alarm-,
  Incident-, Positions- und Übergabeereignissen neu.
- Keine Fake-/Mock-Daten, neue Tabellen oder Lockerungen von RLS, RBAC, CSRF,
  Origin-Schutz oder Audit.

## Bewusst offen / Folgephasen

1. **P1 Alarm-Arbeitsplatz:** Eine vollständige Alarmdetailansicht mit
   Maßnahmen, Kontakten, Objektanweisungen, Einsatzverknüpfungen und
   Kommunikationshistorie als gemeinsamer Bearbeitungskontext.
2. **P1 Aufgaben und SLA:** Ein autorisierter Maßnahmen-/Aufgabenvertrag mit
   Fristen, Rückmeldungen und Eskalationsbezug; der aktuelle Stand zeigt
   bewusst keine nicht vorhandenen Aufgaben als Kennzahl.
3. **P1 Ressourcen-Disposition:** Einsatzstatus und Verfügbarkeit müssen über
   einen verbindlichen Mitarbeiter-/Einsatzvertrag statt über reine
   Incident-Zuordnungen erweitert werden.
4. **P2 Lagekarte und Provider:** Reale Standortdaten, Kartenanbieter und
   Provider-Gesundheit modular anbinden; unkonfigurierte Provider dürfen nicht
   als verifiziert erscheinen.
5. **P2 Alarmqualität/SLA-Berichte:** Fehlalarmgründe, Reaktionszeiten,
   Quittierungsfristen und Prioritäts-/Objektfilter auf bestehenden Audit- und
   Reportverträgen aufbauen.

## CRM-Integration (PR #34)

Der Customer-360/API/UI-Block aus PR #34 ergänzt Kundenkonto- und
Ansprechpartnerdaten. Für die NSL ist er als Kontextquelle für Alarm- und
Incident-Detailansichten vorgesehen: Kunde, Vertragsbezug und berechtigte
Kontaktgruppen sollen dort über autorisierte IDs referenziert werden, ohne
Kontaktdaten in Alarmtabellen zu duplizieren. Dieser Dashboard-Schritt greift
die Integration noch nicht vor und hat daher keinen Konflikt mit PR #34;
die direkte Verknüpfung gehört in die nächste Alarm-Arbeitsplatzphase.

