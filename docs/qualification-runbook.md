# Runbook: Qualifikationen und Wachbuch-Prüfung

Nach Migration `026_qualification_management.sql` werden die Standardcodes je
Mandant angelegt. Admins verwalten Katalog, Mitarbeiter-Zeiträume und
Reminder-Tage unter `/qualifications`; jede Änderung benötigt eine Begründung
und erzeugt einen Audit-Eintrag. Der Reminder-Worker läuft im API-Prozess
einmal täglich. Für produktive Mail-/SMS-Zustellung müssen die bestehenden
Notification-Abonnements und Provider konfiguriert sein.

Migration `027_watchbook_integrity.sql` ergänzt die Hashfelder additiv. Neue
Einträge und Revisionen werden automatisch verkettet. `GET /api/v1/watchbook/integrity`
zeigt nur `valid`, Zähler und betroffene IDs. Bei `valid: false` zuerst den
Audit-/DB-Zugriff sichern, keine Hashwerte überschreiben und die Ursache der
Manipulation untersuchen. Für HMAC-Schutz `WATCHBOOK_HASH_SECRET` ausschließlich
über den Secret-Store setzen; niemals in Repository, Logs oder Frontend.
