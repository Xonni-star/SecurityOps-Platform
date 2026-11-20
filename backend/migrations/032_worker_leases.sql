CREATE TABLE IF NOT EXISTS worker_leases (
  worker_name text PRIMARY KEY CHECK (length(worker_name) BETWEEN 1 AND 160),
  holder_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_leases_expiry_idx ON worker_leases(expires_at);
