/**
 * Verbindliche, serverseitige Statuslogik für Qualifikationen.
 *
 * Gespeicherte Statuswerte sind nur ein Eingangsparameter: Datumsgrenzen,
 * Widerruf, Katalogzustand und Nachweisfreigaben dürfen einen Datensatz
 * niemals künstlich als gültig ausweisen. Alle Verbraucher (Übersicht,
 * Mitarbeiterprofil, Objektakte, Dienstplanung, Erinnerungen) verwenden
 * dieselbe Funktion.
 */

export type QualificationStatus =
  | 'valid'
  | 'expiring'
  | 'expired'
  | 'not_yet_valid'
  | 'revoked'
  | 'invalid'
  | 'missing_evidence'
  | 'awaiting_review';

export const QUALIFICATION_EXPIRING_DAYS = 90;

export const qualificationStatusLabels: Record<QualificationStatus, string> = {
  valid: 'Gültig',
  expiring: 'Läuft bald ab',
  expired: 'Abgelaufen',
  not_yet_valid: 'Noch nicht gültig',
  revoked: 'Widerrufen',
  invalid: 'Ungültig',
  missing_evidence: 'Nachweis fehlt',
  awaiting_review: 'Prüfung ausstehend',
};

export type QualificationStatusResult = {
  status: QualificationStatus;
  label: string;
  days_until_expiry: number | null;
  issue_code: string;
};

export type QualificationStatusInput = {
  storedStatus?: string | null;
  revokedAt?: unknown;
  catalogActive?: boolean | null;
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
  evidenceStatus?: string | null;
  requiresEvidence?: boolean;
  now?: Date;
};

/** Kalendertag in Europe/Berlin; fälschlich UTC-nahe "today()" wird vermieden. */
export function qualificationLocalDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function dayNumber(value: string | Date, now: Date): number {
  if (value instanceof Date) {
    return dayNumber(qualificationLocalDate(value), now);
  }
  const day = String(value).slice(0, 10);
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  return Date.UTC(year, month - 1, date);
}

export function daysUntil(value: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (value === null || value === undefined || value === '') return null;
  const today = dayNumber(qualificationLocalDate(now), now);
  return Math.round((dayNumber(value, now) - today) / 86_400_000);
}

function finalResult(
  status: QualificationStatus,
  days: number | null,
): QualificationStatusResult {
  const issueCodes: Record<QualificationStatus, string> = {
    valid: 'none',
    expiring: 'expiring',
    expired: 'expired',
    not_yet_valid: 'not_yet_valid',
    revoked: 'revoked',
    invalid: 'invalid',
    missing_evidence: 'missing_evidence',
    awaiting_review: 'unapproved_evidence',
  };
  return {status, label: qualificationStatusLabels[status], days_until_expiry: days, issue_code: issueCodes[status]};
}

export function classifyQualification(input: QualificationStatusInput): QualificationStatusResult {
  const now = input.now ?? new Date();
  const stored = String(input.storedStatus ?? '').toLowerCase();
  const days = daysUntil(input.validUntil, now);
  const validFromDays = daysUntil(input.validFrom, now);

  if (stored === 'revoked' || input.revokedAt) return finalResult('revoked', days);
  if (stored === 'invalid' || input.catalogActive === false) return finalResult('invalid', days);
  if (stored === 'expired' || (days !== null && days < 0)) return finalResult('expired', days);
  if (validFromDays !== null && validFromDays > 0) return finalResult('not_yet_valid', days);

  if (input.requiresEvidence) {
    const evidence = String(input.evidenceStatus ?? '');
    if (!evidence || evidence === 'missing' || evidence === 'not_found') {
      return finalResult('missing_evidence', days);
    }
    if (evidence === 'nicht_freigegeben' || evidence === 'pruefung_ausstehend') {
      return finalResult('awaiting_review', days);
    }
    if (evidence === 'abgelaufen' || evidence === 'noch_nicht_gueltig') {
      return {...finalResult('expired', days), issue_code: 'expired_evidence'};
    }
  }

  if (days !== null && days <= QUALIFICATION_EXPIRING_DAYS) return finalResult('expiring', days);
  return finalResult('valid', days);
}

/** Ermittelt den Nachweisstatus aus den vorhandenen DMS-Feldern einer Zuordnung. */
export function evidenceStatusOf(row: {
  document_id?: string | null;
  evidence_document_status?: string | null;
  evidence_approval_status?: string | null;
  evidence_lifecycle_state?: string | null;
  evidence_valid_from?: string | Date | null;
  evidence_valid_until?: string | Date | null;
}, now: Date = new Date()): string | null {
  if (!row.document_id) return 'missing';
  if (!row.evidence_document_status && !row.evidence_lifecycle_state) return 'not_found';
  if (row.evidence_document_status === 'deleted') return 'nicht_freigegeben';
  if (row.evidence_approval_status !== 'approved') {
    return row.evidence_approval_status === 'pending_approval' ? 'pruefung_ausstehend' : 'nicht_freigegeben';
  }
  if (row.evidence_lifecycle_state && row.evidence_lifecycle_state !== 'available') return 'nicht_freigegeben';
  const from = daysUntil(row.evidence_valid_from, now);
  const until = daysUntil(row.evidence_valid_until, now);
  if (from !== null && from > 0) return 'noch_nicht_gueltig';
  if (until !== null && until < 0) return 'abgelaufen';
  return 'gueltig';
}
