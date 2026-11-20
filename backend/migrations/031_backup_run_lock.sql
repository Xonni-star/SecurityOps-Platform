CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_one_running_per_tenant_idx
  ON backup_runs(tenant_id) WHERE status='running';
