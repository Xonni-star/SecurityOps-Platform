# Externe Alarmweiterleitung

Administratoren mit `alarm_forwarding:write` legen technische Ziele (Webhook,
E-Mail oder SMS) und Regeln an. Jede Änderung benötigt einen Grund und erzeugt
ein Audit-Event. Der Worker startet mit dem API-Prozess, verwendet begrenztes
Backoff und markiert endgültig fehlgeschlagene Zustellungen als `exhausted`.

Die Zustände beschreiben ausschließlich technische Übermittlung:
`queued`/„Übermittlung gestartet“, `forwarded`/„technisch bestätigt“,
`acknowledged`/„Quittierung eingegangen“, `retrying`, `failed` und `exhausted`.
Eine Reaktion von Polizei, Feuerwehr oder einer Leitstelle wird niemals
behauptet. Webhook-Secrets werden über `secret_ref` oder verschlüsselte
Serverdaten geladen und nicht in Antworten, Logs oder Auditdetails geschrieben.
