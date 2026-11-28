/**
 * Einheitliche SQL-Klassifikation für Qualifikationen.
 *
 * Die JavaScript-Klassifikation in qualification-status.ts und dieser
 * SQL-Ausdruck müssen dieselben Zustände liefern. Alle Listen, Kennzahlen
 * und Profile verwenden diesen Ausdruck, damit ein Datensatz nicht je nach
 * Ansicht als gültig, abgelaufen oder ungültig erscheint.
 */

export const qualificationTodaySql=`(now() AT TIME ZONE 'Europe/Berlin')::date`;

/** Statusausdruck mit parametrierbaren Alias-Namen für Unterabfragen. */
export function qualificationStatusSql(q='q',c='c',d='d',dv='dv'):string{
  const evidenceRequired=`(${c}.required_document_type IS NOT NULL OR COALESCE(jsonb_array_length(${c}.required_documents),0)>0)`;
  return `CASE
  WHEN ${q}.status='revoked' OR ${q}.revoked_at IS NOT NULL THEN 'revoked'
  WHEN ${q}.status='invalid' OR ${c}.active=false THEN 'invalid'
  WHEN ${q}.status='expired' OR ${q}.valid_until<${qualificationTodaySql} THEN 'expired'
  WHEN ${q}.valid_from>${qualificationTodaySql} THEN 'not_yet_valid'
  WHEN ${evidenceRequired} AND ${q}.document_id IS NULL THEN 'missing_evidence'
  WHEN ${evidenceRequired} AND (${d}.document_status IS DISTINCT FROM 'active' OR ${d}.approval_status IS DISTINCT FROM 'approved' OR ${dv}.lifecycle_state IS DISTINCT FROM 'available') THEN 'awaiting_review'
  WHEN ${evidenceRequired} AND (${d}.valid_from>${qualificationTodaySql} OR ${d}.valid_until<${qualificationTodaySql}) THEN 'expired'
  WHEN ${q}.valid_until<=${qualificationTodaySql}+INTERVAL '90 days' THEN 'expiring'
  ELSE 'valid' END`;
}

/**
 * Zustände aller Qualifikationen eines Mandanten. Nur verfügbare DMS-Versionen
 * gelten als Nachweis; eine quarantänisierte neuere Version verdrängt keine
 * ältere freigegebene.
 */
export function qualificationStatesCte(tenantParam='$1'):string{
  return `WITH states AS (
    SELECT q.id qualification_id,q.employee_id,q.code,q.catalog_id,q.valid_until,${qualificationStatusSql()} AS computed_status
    FROM employee_qualifications q
    LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND (
      (q.catalog_id IS NOT NULL AND c.id=q.catalog_id) OR (q.catalog_id IS NULL AND c.code=q.code))
    LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
    LEFT JOIN LATERAL (
      SELECT v.lifecycle_state FROM dms_versions v
       WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
       ORDER BY v.version_no DESC LIMIT 1
    ) dv ON TRUE
    WHERE q.tenant_id=${tenantParam}
  )`;
}
