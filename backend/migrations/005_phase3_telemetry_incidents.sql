CREATE TABLE IF NOT EXISTS sensor_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sensor_type text NOT NULL CHECK (sensor_type IN ('fall','posture','inactivity','battery')),
  threshold numeric NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  priority_code text NOT NULL DEFAULT 'high',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sensor_type)
);

CREATE TABLE IF NOT EXISTS sensor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sensor_type text NOT NULL CHECK (sensor_type IN ('fall','posture','inactivity','battery')),
  value numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sensor_events_device_time_idx ON sensor_events(tenant_id,device_id,sensor_type,recorded_at DESC);
CREATE INDEX IF NOT EXISTS sensor_events_retention_idx ON sensor_events(created_at);

CREATE TABLE IF NOT EXISTS device_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_positions_device_time_idx ON device_positions(tenant_id,device_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS device_positions_retention_idx ON device_positions(created_at);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alarm_id uuid REFERENCES alarms(id) ON DELETE SET NULL,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  priority_id uuid REFERENCES alarm_priorities(id) ON DELETE RESTRICT,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','en_route','on_site','completed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_tenant_status_idx ON incidents(tenant_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS incident_assignments (
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id,employee_id)
);
CREATE TABLE IF NOT EXISTS incident_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incident_history_incident_idx ON incident_history(incident_id,created_at);

INSERT INTO sensor_thresholds(tenant_id,sensor_type,threshold,duration_seconds,priority_code)
SELECT t.id,v.sensor_type,v.threshold,v.duration_seconds,v.priority_code
FROM tenants t CROSS JOIN (VALUES
  ('fall',1,0,'critical'),('posture',60,0,'critical'),('inactivity',0,300,'high'),('battery',20,0,'medium')
) v(sensor_type,threshold,duration_seconds,priority_code)
ON CONFLICT (tenant_id,sensor_type) DO NOTHING;

INSERT INTO permissions(key,description) VALUES
 ('telemetry:read','View sensor telemetry'),('telemetry:write','Ingest sensor telemetry'),
 ('positions:read','View device positions'),('positions:write','Ingest device positions'),
 ('incidents:read','View incidents'),('incidents:write','Manage incidents')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key IN ('telemetry:read','telemetry:write','positions:read','positions:write','incidents:read','incidents:write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key IN ('telemetry:read','telemetry:write','positions:read','positions:write','incidents:read','incidents:write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'viewer',id FROM permissions WHERE key IN ('telemetry:read','positions:read','incidents:read') ON CONFLICT DO NOTHING;
