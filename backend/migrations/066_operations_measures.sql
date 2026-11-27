-- Additive migration: mandantenbezogene operative Maßnahmen.
-- Die vorhandenen customer_tasks sind kundenbezogen und decken weder
-- Modulzuordnungen noch die geforderten Bearbeitungsstatuswerte ab. Diese
-- Tabelle ergänzt sie, ohne bestehende Daten oder Spalten zu verändern.

CREATE TABLE IF NOT EXISTS public.operations_measures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  incident_id uuid,
  title text NOT NULL,
  description text,
  module text NOT NULL,
  priority text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  assigned_employee_id uuid,
  assigned_user_id uuid,
  site_id uuid,
  due_at timestamp with time zone,
  source_type text,
  source_id uuid,
  source_key text,
  created_by uuid,
  updated_by uuid,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT operations_measures_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT operations_measures_module_check CHECK (module IN (
    'leitstelle','einsatz','schicht','objekt','mitarbeiter','qualifikation',
    'dokument','nfc','schluessel','kunde','system')),
  CONSTRAINT operations_measures_priority_check CHECK (priority IN ('critical','high','medium','low')),
  CONSTRAINT operations_measures_status_check CHECK (status IN ('open','in_progress','on_hold','done','cancelled')),
  CONSTRAINT operations_measures_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT operations_measures_tenant_incident_fk FOREIGN KEY (tenant_id,incident_id)
    REFERENCES public.incidents(tenant_id,id) ON DELETE SET NULL (incident_id),
  CONSTRAINT operations_measures_tenant_employee_fk FOREIGN KEY (tenant_id,assigned_employee_id)
    REFERENCES public.employees(tenant_id,id) ON DELETE SET NULL (assigned_employee_id),
  CONSTRAINT operations_measures_tenant_user_fk FOREIGN KEY (tenant_id,assigned_user_id)
    REFERENCES public.users(tenant_id,id) ON DELETE SET NULL (assigned_user_id),
  CONSTRAINT operations_measures_tenant_site_fk FOREIGN KEY (tenant_id,site_id)
    REFERENCES public.sites(tenant_id,id) ON DELETE SET NULL (site_id),
  CONSTRAINT operations_measures_tenant_created_by_fk FOREIGN KEY (tenant_id,created_by)
    REFERENCES public.users(tenant_id,id) ON DELETE SET NULL (created_by)
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_measures_source_uq
  ON public.operations_measures (tenant_id,source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_measures_tenant_status_idx
  ON public.operations_measures (tenant_id,status,due_at);
CREATE INDEX IF NOT EXISTS operations_measures_tenant_site_idx
  ON public.operations_measures (tenant_id,site_id);
CREATE INDEX IF NOT EXISTS operations_measures_tenant_incident_idx
  ON public.operations_measures (tenant_id,incident_id);

ALTER TABLE public.operations_measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operations_measures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.operations_measures;
CREATE POLICY tenant_isolation ON public.operations_measures
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO public.permissions (id,key,description)
VALUES
  ('00000000-0000-4000-8000-000000000901','operations_measures:read','Operative Maßnahmen lesen'),
  ('00000000-0000-4000-8000-000000000902','operations_measures:write','Operative Maßnahmen bearbeiten')
ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key, description=EXCLUDED.description, updated_at=now();

INSERT INTO public.role_permissions (role,permission_id,scope)
SELECT r.role,p.id,r.scope FROM public.permissions p
CROSS JOIN (VALUES ('admin','tenant'),('operator','tenant'),('viewer','tenant'),('superadmin','system')) AS r(role,scope)
WHERE p.key='operations_measures:read'
ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role,permission_id,scope)
SELECT r.role,p.id,r.scope FROM public.permissions p
CROSS JOIN (VALUES ('admin','tenant'),('operator','tenant'),('superadmin','system')) AS r(role,scope)
WHERE p.key='operations_measures:write'
ON CONFLICT (role,permission_id) DO NOTHING;
