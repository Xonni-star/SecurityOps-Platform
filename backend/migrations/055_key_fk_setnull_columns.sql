-- Repair inherited composite key foreign keys whose ON DELETE SET NULL clause did
-- not name a column. PostgreSQL would otherwise null the whole referencing key,
-- including the NOT NULL tenant_id, and abort the delete with 23502. The only
-- behaviour we want is to detach the optional reference while keeping the row
-- and its tenant. Data, ids and history stay untouched.

DO $$
DECLARE
  fk record;
  null_column text;
  referenced_columns text;
  target_table text;
  reference_table text;
BEGIN
  FOR fk IN
    SELECT c.conname,c.conrelid,c.confrelid,c.conkey,c.confkey
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.contype='f'
      AND c.confdeltype='n'
      AND t.relnamespace='public'::regnamespace
      AND t.relname IN (
        'keys','key_movements','key_receipts','key_loss_reports','key_qr_tokens',
        'key_inventory_checks','key_inventory_check_items','key_bundles',
        'key_bundle_items','key_bundle_movements','key_reminder_state'
      )
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
      RAISE EXCEPTION 'Refusing to rewrite ambiguous key foreign key % on %',fk.conname,target_table;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target_table,fk.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id,%I) REFERENCES public.%I(%s) ON DELETE SET NULL (%I)',
      target_table,fk.conname,null_column,reference_table,referenced_columns,null_column
    );
  END LOOP;
END $$;

-- The movement trigger must remain append-only for user edits while allowing the
-- database's own referential action to detach a deleted device from a movement.
CREATE OR REPLACE FUNCTION prevent_key_movement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'key movement history is immutable';
  END IF;
  IF OLD.device_id IS NOT NULL AND NEW.device_id IS NULL
    AND (to_jsonb(NEW)-'device_id')=(to_jsonb(OLD)-'device_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'key movement history is immutable';
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
      AND t.relname IN (
        'keys','key_movements','key_receipts','key_loss_reports','key_qr_tokens',
        'key_inventory_checks','key_inventory_check_items','key_bundles',
        'key_bundle_items','key_bundle_movements','key_reminder_state'
      )
      AND pg_get_constraintdef(c.oid) ~* 'ON DELETE SET NULL'
      AND pg_get_constraintdef(c.oid) !~* 'ON DELETE SET NULL\s*\('
  ) THEN
    RAISE EXCEPTION 'A key foreign key still uses ON DELETE SET NULL without an explicit column list';
  END IF;
END $$;
