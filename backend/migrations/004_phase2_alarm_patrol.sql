ALTER TABLE alarms ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'alarm';
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS priority_id uuid;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'system';
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0;
ALTER TABLE alarms DROP CONSTRAINT IF EXISTS alarms_status_check;
ALTER TABLE alarms ADD CONSTRAINT alarms_status_check CHECK (status IN ('open','acknowledged','escalated','resolved'));
UPDATE alarms SET status='acknowledged' WHERE status='acknowledged';
UPDATE alarms SET type='alarm', description=message WHERE description IS NULL;

CREATE TABLE IF NOT EXISTS alarm_priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, code text NOT NULL, rank integer NOT NULL CHECK (rank > 0),
  color text NOT NULL DEFAULT '#64748b', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, rank)
);
ALTER TABLE alarms ADD CONSTRAINT alarms_priority_fk FOREIGN KEY (priority_id) REFERENCES alarm_priorities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS alarms_priority_idx ON alarms(priority_id);

CREATE TABLE IF NOT EXISTS alarm_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alarm_id uuid NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, from_status text, to_status text NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL, note text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarm_history_alarm_idx ON alarm_history(alarm_id, created_at);
CREATE TABLE IF NOT EXISTS escalation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, priority_id uuid REFERENCES alarm_priorities(id) ON DELETE CASCADE,
  delay_seconds integer NOT NULL CHECK (delay_seconds > 0), target_status text NOT NULL DEFAULT 'escalated',
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name text NOT NULL, nfc_uid text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nfc_uid), UNIQUE (site_id, sequence)
);
CREATE TABLE IF NOT EXISTS patrol_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name text NOT NULL, expected_start time,
  expected_end time, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS patrol_route_points (
  route_id uuid NOT NULL REFERENCES patrol_routes(id) ON DELETE CASCADE,
  control_point_id uuid NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0), expected_offset_seconds integer CHECK (expected_offset_seconds >= 0),
  PRIMARY KEY(route_id, control_point_id), UNIQUE(route_id, sequence)
);
CREATE TABLE IF NOT EXISTS patrol_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES patrol_routes(id) ON DELETE CASCADE, employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, ends_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS patrol_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES patrol_routes(id) ON DELETE CASCADE, control_point_id uuid NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT, scanned_at timestamptz NOT NULL DEFAULT now(),
  deviation text NOT NULL DEFAULT 'none' CHECK (deviation IN ('none','late','skipped','out_of_order'))
);

INSERT INTO alarm_priorities(tenant_id,name,code,rank,color)
SELECT t.id,v.name,v.code,v.rank,v.color FROM tenants t CROSS JOIN (VALUES
 ('Kritisch','critical',1,'#dc2626'),('Hoch','high',2,'#ea580c'),('Mittel','medium',3,'#ca8a04'),('Niedrig','low',4,'#16a34a')
) v(name,code,rank,color) ON CONFLICT (tenant_id,code) DO NOTHING;
UPDATE alarms a SET priority_id=p.id FROM alarm_priorities p WHERE a.priority_id IS NULL AND p.tenant_id=a.tenant_id AND p.code=a.severity;
INSERT INTO permissions(key,description) VALUES
 ('alarm_priorities:read','View alarm priorities'),('alarm_priorities:write','Manage alarm priorities'),
 ('escalation_rules:read','View escalation rules'),('escalation_rules:write','Manage escalation rules'),
 ('patrols:read','View patrol routes and scans'),('patrols:write','Manage patrol routes and scans')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id) SELECT 'admin',id FROM permissions WHERE key IN ('alarm_priorities:read','alarm_priorities:write','escalation_rules:read','escalation_rules:write','patrols:read','patrols:write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id) SELECT 'operator',id FROM permissions WHERE key IN ('alarm_priorities:read','escalation_rules:read','patrols:read','patrols:write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id) SELECT 'viewer',id FROM permissions WHERE key IN ('alarm_priorities:read','escalation_rules:read','patrols:read') ON CONFLICT DO NOTHING;
