ALTER TABLE qualification_catalog ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE qualification_catalog ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE qualification_catalog ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false;
ALTER TABLE qualification_catalog ADD COLUMN IF NOT EXISTS required_documents jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS document_id uuid;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS issuing_authority text;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'valid';
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_status_check;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_status_check CHECK (status IN ('valid','expired','revoked','invalid'));
CREATE INDEX IF NOT EXISTS employee_qualifications_expiry_idx ON employee_qualifications(tenant_id,valid_until,status);

ALTER TABLE watchbook_revisions ADD COLUMN IF NOT EXISTS canonical_payload_hash text;
ALTER TABLE watchbook_revisions ADD COLUMN IF NOT EXISTS previous_revision_hash text;
ALTER TABLE watchbook_revisions ADD COLUMN IF NOT EXISTS revision_hash text;
ALTER TABLE watchbook_revisions ADD COLUMN IF NOT EXISTS hash_algorithm_version text NOT NULL DEFAULT 'sha256-v1';
ALTER TABLE watchbook_revisions ADD COLUMN IF NOT EXISTS hmac_version text;
CREATE INDEX IF NOT EXISTS watchbook_revisions_revision_hash_idx ON watchbook_revisions(tenant_id,entry_id,revision_no,revision_hash);
