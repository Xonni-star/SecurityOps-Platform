-- Additive Migration: Standard-Vorfallarten auch für nach der Migration neu
-- angelegte Mandanten bereitstellen. 001-067 bleiben unverändert.

CREATE OR REPLACE FUNCTION seed_incident_types_for_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO incident_types(tenant_id,code,name,description)
  SELECT NEW.id,v.code,v.name,v.description FROM (VALUES
    ('technical_fault','Technischer Fehler','Technische Störung an Anlage oder Gerät'),
    ('alarm','Alarm','Ausgelöster Alarm'),
    ('key_loss','Schlüsselverlust','Verlust oder Missbrauch eines Schlüssels'),
    ('nfc_loss','NFC-Verlust','Verlust oder Ausfall eines NFC-Mediums'),
    ('qualification_gap','Qualifikationslücke','Fehlende oder ungültige Qualifikation'),
    ('staffing_gap','Besetzungslücke','Unzureichende Besetzung'),
    ('hazard','Gefährdung','Gefährdung von Personen oder Objekten'),
    ('other','Sonstiges','Sonstiger Vorfall')
  ) v(code,name,description)
  ON CONFLICT (tenant_id,code) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tenants_seed_incident_types ON tenants;
CREATE TRIGGER tenants_seed_incident_types
  AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION seed_incident_types_for_tenant();

DO $$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',tenant_record.id::text,true);
    INSERT INTO incident_types(tenant_id,code,name,description)
    SELECT tenant_record.id,v.code,v.name,v.description FROM (VALUES
      ('technical_fault','Technischer Fehler','Technische Störung an Anlage oder Gerät'),
      ('alarm','Alarm','Ausgelöster Alarm'),
      ('key_loss','Schlüsselverlust','Verlust oder Missbrauch eines Schlüssels'),
      ('nfc_loss','NFC-Verlust','Verlust oder Ausfall eines NFC-Mediums'),
      ('qualification_gap','Qualifikationslücke','Fehlende oder ungültige Qualifikation'),
      ('staffing_gap','Besetzungslücke','Unzureichende Besetzung'),
      ('hazard','Gefährdung','Gefährdung von Personen oder Objekten'),
      ('other','Sonstiges','Sonstiger Vorfall')
    ) v(code,name,description)
    ON CONFLICT (tenant_id,code) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;
