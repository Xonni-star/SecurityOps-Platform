# Account-Lockout und Passwortschutz

Fehlgeschlagene Logins werden pro Konto gezählt; nach dem konfigurierten
Schwellwert (`LOGIN_MAX_FAILURES`, standardmäßig 5) wird temporär gesperrt
(`LOGIN_LOCK_MINUTES`, standardmäßig 15). IP-Rate-Limiting, MFA-Sperren und
einheitliche Loginfehler bleiben aktiv. Admins benötigen
`account_security:manage` und eine Begründung zur Entsperrung; die Aktion wird
auditiert.

Passwortwechsel erfordern mindestens `PASSWORD_MIN_LENGTH` Zeichen sowie Groß-,
Kleinbuchstaben, Zahl und Sonderzeichen. Die letzten fünf Passwort-Hashes
werden serverseitig geprüft und niemals ausgegeben. Migration `030` ist
additiv; bei Rollback der Anwendung bleiben die neuen Spalten bestehen.
