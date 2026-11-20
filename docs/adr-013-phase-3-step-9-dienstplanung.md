# ADR-013: Dienstplanung (Phase 3, Schritt 9)

Migration 016 ergänzt additive, tenant-scoped Dienstplanung: versionierbare Regelprofile, Perioden, Schichten, Mitarbeiter-Zuordnungen, Qualifikationen, Abwesenheiten und gespeicherte Konfliktbefunde. Standortbezug wird über zusammengesetzte Fremdschlüssel und die bestehenden Site-Scope-Berechtigungen begrenzt.

Regelprofile enthalten ausschließlich tenant-konfigurierbare Parameter (`jsonb`), zum Beispiel `max_shift_minutes`, `min_rest_minutes` oder `required_qualification_codes`. Es gibt keine hartcodierten Tarif- oder Arbeitszeitregeln und keine Rechts- oder Tarifaussage. Eine rechtliche und tarifliche Abnahme ist ausdrücklich offen und muss separat erfolgen.

Mutationen benötigen die bestehende Session-/CSRF-Prüfung, passende RBAC-Berechtigung, Audit und `Idempotency-Key` beziehungsweise `client_mutation_id`. Replay liefert die gespeicherte Antwort. Überlappungen, fehlende Qualifikationen, Abwesenheiten und konfigurierte Regelabweichungen werden als `schedule_conflicts` mit Typ, Schweregrad und Details gespeichert; sie führen nicht zu einer stillen Ablehnung.

Die Frontend-Ansicht zeigt Perioden, Regelprofil-Versionen und offene Befunde. Vollständige Qualifikations- und Abwesenheitsstammdaten bleiben den bestehenden Mitarbeiterprozessen vorbehalten.
