-- Phase 3, step 12: confirmed, participant-bound shift handover protocols.
-- Existing migrations remain unchanged. All corrections and revocations append
-- a new event or confirmation row instead of mutating history.

CREATE TABLE IF NOT EXISTS handover_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  shift_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','voided')),
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_device_id uuid,
  client_mutation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES schedule_shifts(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_device_id) REFERENCES devices(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS handover_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handover_id uuid NOT NULL,
  participant_role text NOT NULL CHECK (participant_role IN ('outgoing','incoming','witness')),
  user_id uuid,
  employee_id uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  assigned_by uuid NOT NULL,
  assigned_session_id uuid NOT NULL,
  assigned_device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, handover_id, participant_role, user_id, employee_id),
  FOREIGN KEY (tenant_id, handover_id) REFERENCES handover_records(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assigned_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assigned_device_id) REFERENCES devices(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((user_id IS NOT NULL) <> (employee_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS handover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handover_id uuid NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'created','participant_assigned','participant_revoked',
    'confirmation_recorded','confirmation_revoked','corrected',
    'conflict_detected','voided'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  device_id uuid,
  previous_event_hash text CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, handover_id, sequence_no),
  FOREIGN KEY (tenant_id, handover_id) REFERENCES handover_records(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS handover_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handover_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('confirmed','revoked')),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid NOT NULL,
  device_id uuid,
  supersedes_confirmation_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, handover_id) REFERENCES handover_records(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, participant_id) REFERENCES handover_participants(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, supersedes_confirmation_id) REFERENCES handover_confirmations(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS handover_records_site_created_idx ON handover_records(tenant_id, site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handover_participants_handover_idx ON handover_participants(tenant_id, handover_id, state);
CREATE INDEX IF NOT EXISTS handover_events_handover_idx ON handover_events(tenant_id, handover_id, sequence_no);
CREATE INDEX IF NOT EXISTS handover_confirmations_current_idx ON handover_confirmations(tenant_id, handover_id, participant_id, confirmed_at DESC);

CREATE OR REPLACE FUNCTION prevent_handover_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Handover history is append-only' USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS handover_events_immutable ON handover_events;
CREATE TRIGGER handover_events_immutable
  BEFORE UPDATE OR DELETE ON handover_events
  FOR EACH ROW EXECUTE FUNCTION prevent_handover_history_mutation();
DROP TRIGGER IF EXISTS handover_confirmations_immutable ON handover_confirmations;
CREATE TRIGGER handover_confirmations_immutable
  BEFORE UPDATE OR DELETE ON handover_confirmations
  FOR EACH ROW EXECUTE FUNCTION prevent_handover_history_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'handover_records','handover_participants','handover_events','handover_confirmations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key, description) VALUES
  ('handover:read', 'View site-scoped shift handovers and immutable history'),
  ('handover:write', 'Create handover protocols and assign participants'),
  ('handover:confirm', 'Confirm or revoke own handover participation'),
  ('handover:correct', 'Append a correction event to a handover protocol'),
  ('handover:revoke', 'Revoke an assigned participant or void a handover')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('handover:read','handover:write','handover:confirm','handover:correct','handover:revoke')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, CASE WHEN key='handover:confirm' THEN 'own' ELSE 'site' END FROM permissions
WHERE key IN ('handover:read','handover:write','handover:confirm','handover:correct','handover:revoke')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'site' FROM permissions WHERE key='handover:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('handover:read','handover:write','handover:confirm','handover:correct','handover:revoke')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry',
    'scheduling.period','scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost','keys.deactivate',
    'handover.create','handover.participant','handover.confirm','handover.revoke','handover.correct'
  ));
