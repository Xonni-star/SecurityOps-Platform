-- Repair inherited composite tenant foreign keys whose ON DELETE SET NULL clause did
-- not name a column. PostgreSQL would otherwise null the whole referencing key,
-- including the NOT NULL tenant_id, and abort the parent delete with 23502.
-- Only the optional reference is detached; rows, ids, tenants and history stay untouched.
-- Migration 055 did this for the key tables; this covers every remaining public table.

DO $$
DECLARE
  fk record;
  null_column text;
  referenced_columns text;
  target_table text;
  reference_table text;
  rewritten integer := 0;
BEGIN
  FOR fk IN
    SELECT c.conname,c.conrelid,c.confrelid,c.conkey,c.confkey
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.contype='f'
      AND c.confdeltype='n'
      AND t.relnamespace='public'::regnamespace
      AND array_length(c.conkey,1)=2
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=c.conkey[1])='tenant_id'
      AND pg_get_constraintdef(c.oid) ~* 'ON DELETE SET NULL'
      AND pg_get_constraintdef(c.oid) !~* 'ON DELETE SET NULL\s*\('
  LOOP
    SELECT a.attname INTO null_column
    FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attnum=(fk.conkey)[2];

    SELECT string_agg(quote_ident(a.attname),',' ORDER BY cols.ord) INTO referenced_columns
    FROM unnest(fk.confkey) WITH ORDINALITY AS cols(attnum,ord)
    JOIN pg_attribute a ON a.attrelid=fk.confrelid AND a.attnum=cols.attnum;

    SELECT c.relname INTO target_table FROM pg_class c WHERE c.oid=fk.conrelid;
    SELECT c.relname INTO reference_table FROM pg_class c WHERE c.oid=fk.confrelid;

    IF null_column IS NULL OR null_column='tenant_id' OR referenced_columns IS NULL THEN
      RAISE EXCEPTION 'Refusing to rewrite ambiguous tenant foreign key % on %',fk.conname,target_table;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid=fk.conrelid AND a.attnum=(fk.conkey)[2] AND a.attnotnull
    ) THEN
      RAISE EXCEPTION 'Refusing to rewrite NOT NULL reference column % on %',null_column,target_table;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target_table,fk.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id,%I) REFERENCES public.%I(%s) ON DELETE SET NULL (%I)',
      target_table,fk.conname,null_column,reference_table,referenced_columns,null_column
    );
    rewritten := rewritten + 1;
  END LOOP;

  RAISE NOTICE 'Rewrote % tenant foreign keys with an explicit SET NULL column',rewritten;
END $$;

-- The same constraint name was reused in migration 045, so the intended FK for
-- dms_documents.responsible_employee_id was never created. Add it defensively:
-- NOT VALID keeps the migration applicable to databases with legacy orphans,
-- while all new writes are checked immediately. Validate clean databases.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_responsible_fk') THEN
    ALTER TABLE public.dms_documents
      ADD CONSTRAINT dms_documents_tenant_responsible_fk
      FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES public.employees(tenant_id,id)
      ON DELETE SET NULL (responsible_employee_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.dms_documents d
    LEFT JOIN public.employees e
      ON e.tenant_id=d.tenant_id AND e.id=d.responsible_employee_id
    WHERE d.responsible_employee_id IS NOT NULL AND e.id IS NULL
  ) THEN
    ALTER TABLE public.dms_documents VALIDATE CONSTRAINT dms_documents_tenant_responsible_fk;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.contype='f'
      AND c.confdeltype='n'
      AND t.relnamespace='public'::regnamespace
      AND array_length(c.conkey,1)=2
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=c.conkey[1])='tenant_id'
      AND pg_get_constraintdef(c.oid) ~* 'ON DELETE SET NULL'
      AND pg_get_constraintdef(c.oid) !~* 'ON DELETE SET NULL\s*\('
  ) THEN
    RAISE EXCEPTION 'A tenant foreign key still uses ON DELETE SET NULL without an explicit column list';
  END IF;
END $$;
