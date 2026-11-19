CREATE TABLE IF NOT EXISTS nfc_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  identifier text NOT NULL,
  device_type text NOT NULL,
  manufacturer text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lost','blocked','replaced')),
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  control_point_id uuid REFERENCES control_points(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,identifier),
  CHECK (num_nonnulls(employee_id,site_id,control_point_id) <= 1)
);
CREATE INDEX IF NOT EXISTS nfc_devices_tenant_status_idx ON nfc_devices(tenant_id,status);
CREATE INDEX IF NOT EXISTS nfc_devices_control_point_idx ON nfc_devices(control_point_id);

INSERT INTO permissions(key,description) VALUES
 ('nfc_devices:read','View NFC device inventory'),
 ('nfc_devices:write','Manage NFC device inventory and assignments')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key IN ('nfc_devices:read','nfc_devices:write')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key IN ('nfc_devices:read','nfc_devices:write')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'viewer',id FROM permissions WHERE key='nfc_devices:read'
ON CONFLICT DO NOTHING;
