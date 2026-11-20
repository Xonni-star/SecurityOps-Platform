# ADR-009: Granulare Permission-Grants für Phase 1, Schritt 4

## Status

Angenommen für Phase 1, Schritt 4.

## Entscheidung

Permission-Codes bleiben kanonisch im Format `resource:verb` aus ADR-008.
`role_permissions.scope` trägt den Zugriffsumfang `tenant`, `site`, `own`
oder `system`; der Scope wird nicht an den Code angehängt. Bestehende
Rollen und tenant-weite Grants bleiben gültig und werden durch Migration 011
additiv weitergeführt.

- `tenant`: Zugriff innerhalb des authentifizierten Tenant-Kontexts.
- `site`: Zugriff nur für Sites aus `user_sites`; Handler müssen die Site
  zusätzlich in der SQL-Abfrage erzwingen.
- `own`: Zugriff nur auf Datensätze mit einem Eintrag in
  `resource_owners`; neue generische CRUD-Datensätze erhalten diesen Eintrag
  beim Anlegen.
- `system`: nur für `role=superadmin` und `users.is_system_admin=true`.
  Auch diese Rechte umgehen weder Request-Kontext noch PostgreSQL-RLS.

`permissions` und `role_permissions` bleiben globale Referenzdaten. RLS
bleibt die endgültige Datenbankautorität; die Middleware ist eine
frühe, explizite Ablehnung und kein Ersatz für RLS. Site-Zuordnungen und
Ownership werden tenant-scoped gespeichert und selbst durch RLS geschützt.

## Rückwärtskompatibilität und Migration

Die drei bestehenden Rollen `admin`, `operator` und `viewer` erhalten ihre
bisherige Semantik als tenant-scoped Grants. Alte Sessions bzw. Test-Fixtures,
die nur ein flaches `permissions`-Array liefern, werden ausschließlich als
tenant-scoped Grants interpretiert; daraus entsteht kein Site-, Own- oder
System-Zugriff. Neue Writes verwenden nur kanonische Codes und strukturierte
Grants. Es gibt keine Alias-Tabelle und keinen rollenbasierten Bypass.

`superadmin` wird nicht aus bestehenden `admin`-Benutzern abgeleitet. Ein
Systemrecht ist nur wirksam, wenn die Rolle und das explizite Flag gemeinsam
vorliegen. Die Migration legt dafür keine Benutzer an.
