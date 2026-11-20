-- Phase 1, step 3: tenant isolation. This migration is intentionally additive.
-- tenants, permissions, and role_permissions remain global reference data.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE sessions s SET tenant_id=u.tenant_id FROM users u WHERE u.id=s.user_id AND s.tenant_id IS NULL;
ALTER TABLE sessions ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE patrol_route_points ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE patrol_route_points p SET tenant_id=r.tenant_id FROM patrol_routes r WHERE r.id=p.route_id AND p.tenant_id IS NULL;
ALTER TABLE patrol_route_points ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE incident_assignments ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE incident_assignments a SET tenant_id=i.tenant_id FROM incidents i WHERE i.id=a.incident_id AND a.tenant_id IS NULL;
ALTER TABLE incident_assignments ALTER COLUMN tenant_id SET NOT NULL;

DO $$
DECLARE
  relation text[];
  violated boolean;
BEGIN
  FOREACH relation SLICE 1 IN ARRAY ARRAY[
    ARRAY['sessions','user_id','users'],
    ARRAY['devices','site_id','sites'],
    ARRAY['alarms','device_id','devices'],
    ARRAY['alarms','site_id','sites'],
    ARRAY['alarms','employee_id','employees'],
    ARRAY['alarms','priority_id','alarm_priorities'],
    ARRAY['alarms','acknowledged_by','users'],
    ARRAY['alarm_history','alarm_id','alarms'],
    ARRAY['alarm_history','changed_by','users'],
    ARRAY['escalation_rules','priority_id','alarm_priorities'],
    ARRAY['control_points','site_id','sites'],
    ARRAY['patrol_routes','site_id','sites'],
    ARRAY['patrol_route_points','route_id','patrol_routes'],
    ARRAY['patrol_route_points','control_point_id','control_points'],
    ARRAY['patrol_assignments','route_id','patrol_routes'],
    ARRAY['patrol_assignments','employee_id','employees'],
    ARRAY['patrol_scans','route_id','patrol_routes'],
    ARRAY['patrol_scans','control_point_id','control_points'],
    ARRAY['patrol_scans','employee_id','employees'],
    ARRAY['sensor_events','device_id','devices'],
    ARRAY['device_positions','device_id','devices'],
    ARRAY['incidents','alarm_id','alarms'],
    ARRAY['incidents','site_id','sites'],
    ARRAY['incidents','employee_id','employees'],
    ARRAY['incidents','priority_id','alarm_priorities'],
    ARRAY['incidents','created_by','users'],
    ARRAY['incident_assignments','incident_id','incidents'],
    ARRAY['incident_assignments','employee_id','employees'],
    ARRAY['incident_assignments','assigned_by','users'],
    ARRAY['incident_history','incident_id','incidents'],
    ARRAY['incident_history','changed_by','users'],
    ARRAY['notification_subscriptions','user_id','users'],
    ARRAY['notifications','user_id','users'],
    ARRAY['direct_messages','sender_user_id','users'],
    ARRAY['direct_messages','recipient_user_id','users'],
    ARRAY['direct_messages','recipient_employee_id','employees'],
    ARRAY['shift_handovers','created_by','users'],
    ARRAY['shift_handovers','acknowledged_by','users'],
    ARRAY['audit_events','actor_user_id','users'],
    ARRAY['work_time_entries','employee_id','employees'],
    ARRAY['nfc_devices','employee_id','employees'],
    ARRAY['nfc_devices','site_id','sites'],
    ARRAY['nfc_devices','control_point_id','control_points'],
    ARRAY['push_subscriptions','user_id','users']
  ] LOOP
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1 FROM %I child JOIN %I parent ON parent.id=child.%I
         WHERE child.%I IS NOT NULL AND child.tenant_id IS DISTINCT FROM parent.tenant_id
       )',
      relation[1],relation[3],relation[2],relation[2]
    ) INTO violated;
    IF violated THEN
      RAISE EXCEPTION 'Cross-tenant relationship detected in %.% -> %',relation[1],relation[2],relation[3]
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_uidx ON users(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_id_uidx ON employees(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_id_uidx ON customers(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS sites_tenant_id_uidx ON sites(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_tenant_id_uidx ON devices(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_tenant_id_uidx ON sessions(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS alarms_tenant_id_uidx ON alarms(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS alarm_priorities_tenant_id_uidx ON alarm_priorities(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS alarm_history_tenant_id_uidx ON alarm_history(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS escalation_rules_tenant_id_uidx ON escalation_rules(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS control_points_tenant_id_uidx ON control_points(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS patrol_routes_tenant_id_uidx ON patrol_routes(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS patrol_route_points_tenant_id_uidx ON patrol_route_points(tenant_id,route_id,control_point_id);
CREATE UNIQUE INDEX IF NOT EXISTS patrol_assignments_tenant_id_uidx ON patrol_assignments(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS patrol_scans_tenant_id_uidx ON patrol_scans(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS sensor_thresholds_tenant_id_uidx ON sensor_thresholds(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS sensor_events_tenant_id_uidx ON sensor_events(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS device_positions_tenant_id_uidx ON device_positions(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_tenant_id_uidx ON incidents(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS incident_assignments_tenant_id_uidx ON incident_assignments(tenant_id,incident_id,employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS incident_history_tenant_id_uidx ON incident_history(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_subscriptions_tenant_id_uidx ON notification_subscriptions(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_tenant_id_uidx ON notifications(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_tenant_id_uidx ON notification_deliveries(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS direct_messages_tenant_id_uidx ON direct_messages(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS shift_handovers_tenant_id_uidx ON shift_handovers(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_tenant_id_uidx ON audit_events(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS work_time_entries_tenant_id_uidx ON work_time_entries(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS timescan_connections_tenant_id_uidx ON timescan_connections(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS timescan_sync_runs_tenant_id_uidx ON timescan_sync_runs(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_tenant_id_uidx ON retention_policies(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS nfc_devices_tenant_id_uidx ON nfc_devices(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_tenant_id_uidx ON push_subscriptions(tenant_id,id);

ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_user_fk FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE devices ADD CONSTRAINT devices_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL (site_id);
ALTER TABLE alarms ADD CONSTRAINT alarms_tenant_device_fk FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE SET NULL (device_id);
ALTER TABLE alarms ADD CONSTRAINT alarms_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL (site_id);
ALTER TABLE alarms ADD CONSTRAINT alarms_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (employee_id);
ALTER TABLE alarms ADD CONSTRAINT alarms_tenant_priority_fk FOREIGN KEY (tenant_id,priority_id) REFERENCES alarm_priorities(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE alarms ADD CONSTRAINT alarms_tenant_acknowledged_by_fk FOREIGN KEY (tenant_id,acknowledged_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (acknowledged_by);
ALTER TABLE alarm_history ADD CONSTRAINT alarm_history_tenant_alarm_fk FOREIGN KEY (tenant_id,alarm_id) REFERENCES alarms(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE alarm_history ADD CONSTRAINT alarm_history_tenant_changed_by_fk FOREIGN KEY (tenant_id,changed_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (changed_by);
ALTER TABLE escalation_rules ADD CONSTRAINT escalation_rules_tenant_priority_fk FOREIGN KEY (tenant_id,priority_id) REFERENCES alarm_priorities(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE control_points ADD CONSTRAINT control_points_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_routes ADD CONSTRAINT patrol_routes_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_route_points ADD CONSTRAINT patrol_route_points_tenant_route_fk FOREIGN KEY (tenant_id,route_id) REFERENCES patrol_routes(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_route_points ADD CONSTRAINT patrol_route_points_tenant_control_point_fk FOREIGN KEY (tenant_id,control_point_id) REFERENCES control_points(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_assignments ADD CONSTRAINT patrol_assignments_tenant_route_fk FOREIGN KEY (tenant_id,route_id) REFERENCES patrol_routes(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_assignments ADD CONSTRAINT patrol_assignments_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_scans ADD CONSTRAINT patrol_scans_tenant_route_fk FOREIGN KEY (tenant_id,route_id) REFERENCES patrol_routes(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_scans ADD CONSTRAINT patrol_scans_tenant_control_point_fk FOREIGN KEY (tenant_id,control_point_id) REFERENCES control_points(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE patrol_scans ADD CONSTRAINT patrol_scans_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE sensor_events ADD CONSTRAINT sensor_events_tenant_device_fk FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE device_positions ADD CONSTRAINT device_positions_tenant_device_fk FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_alarm_fk FOREIGN KEY (tenant_id,alarm_id) REFERENCES alarms(tenant_id,id) ON DELETE SET NULL (alarm_id);
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL (site_id);
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (employee_id);
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_priority_fk FOREIGN KEY (tenant_id,priority_id) REFERENCES alarm_priorities(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_created_by_fk FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (created_by);
ALTER TABLE incident_assignments ADD CONSTRAINT incident_assignments_tenant_incident_fk FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE incident_assignments ADD CONSTRAINT incident_assignments_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE incident_assignments ADD CONSTRAINT incident_assignments_tenant_assigned_by_fk FOREIGN KEY (tenant_id,assigned_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (assigned_by);
ALTER TABLE incident_history ADD CONSTRAINT incident_history_tenant_incident_fk FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE incident_history ADD CONSTRAINT incident_history_tenant_changed_by_fk FOREIGN KEY (tenant_id,changed_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (changed_by);
ALTER TABLE notification_subscriptions ADD CONSTRAINT notification_subscriptions_tenant_user_fk FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_tenant_user_fk FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_tenant_sender_fk FOREIGN KEY (tenant_id,sender_user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_tenant_recipient_fk FOREIGN KEY (tenant_id,recipient_user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_tenant_employee_fk FOREIGN KEY (tenant_id,recipient_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (recipient_employee_id);
ALTER TABLE shift_handovers ADD CONSTRAINT shift_handovers_tenant_created_by_fk FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE shift_handovers ADD CONSTRAINT shift_handovers_tenant_acknowledged_by_fk FOREIGN KEY (tenant_id,acknowledged_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (acknowledged_by);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_tenant_actor_fk FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL (actor_user_id);
ALTER TABLE work_time_entries ADD CONSTRAINT work_time_entries_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (employee_id);
ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_tenant_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (employee_id);
ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_tenant_site_fk FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL (site_id);
ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_tenant_control_point_fk FOREIGN KEY (tenant_id,control_point_id) REFERENCES control_points(tenant_id,id) ON DELETE SET NULL (control_point_id);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_tenant_user_fk FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','employees','customers','sites','devices','sessions','alarms','alarm_priorities',
    'alarm_history','escalation_rules','control_points','patrol_routes','patrol_route_points',
    'patrol_assignments','patrol_scans','sensor_thresholds','sensor_events','device_positions',
    'incidents','incident_assignments','incident_history','notification_subscriptions',
    'notifications','notification_deliveries','direct_messages','shift_handovers','audit_events',
    'work_time_entries','timescan_connections','timescan_sync_runs','retention_policies',
    'nfc_devices','push_subscriptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS users_login_lookup ON users;
CREATE POLICY users_login_lookup ON users FOR SELECT
  USING (email = current_setting('app.login_email', true));

DROP POLICY IF EXISTS sessions_lookup ON sessions;
CREATE POLICY sessions_lookup ON sessions FOR SELECT
  USING (token_hash = current_setting('app.session_token_hash', true));

DROP POLICY IF EXISTS users_session_lookup ON users;
CREATE POLICY users_session_lookup ON users FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.user_id=users.id
      AND s.token_hash=current_setting('app.session_token_hash', true)
  ));
