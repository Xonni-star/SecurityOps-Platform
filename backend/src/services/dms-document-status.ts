import type {DmsLifecycleState} from './dms-domain.js';

/**
 * Server-side, single-valued document status classification.
 *
 * All object/document views share these functions so that status labels and
 * expiry buckets can never overlap or contradict each other. The functions are
 * deliberately pure: they only receive already authorised database rows.
 */

export type DocumentStatusCategory =
  | 'gueltig'
  | 'lauf_bald_ab'
  | 'bald_pruefpflichtig'
  | 'abgelaufen'
  | 'fehlend'
  | 'nicht_freigegeben'
  | 'pruefung_ausstehend'
  | 'noch_nicht_gueltig';

export type ExpiryBucket =
  | 'expired'
  | 'within_7_days'
  | 'within_8_30_days'
  | 'within_31_60_days'
  | 'beyond_60_days'
  | 'no_expiry';

export type ReviewState = 'none' | 'pending' | 'due_soon' | 'overdue';

export const documentStatusLabels: Record<DocumentStatusCategory, string> = {
  gueltig: 'Gültig',
  lauf_bald_ab: 'Läuft bald ab',
  bald_pruefpflichtig: 'Bald prüfpflichtig',
  abgelaufen: 'Abgelaufen',
  fehlend: 'Fehlt',
  nicht_freigegeben: 'Nicht freigegeben',
  pruefung_ausstehend: 'Prüfung ausstehend',
  noch_nicht_gueltig: 'Noch nicht gültig',
};

export type ClassifiableDocument = {
  document_status?: string | null;
  approval_status?: string | null;
  valid_from?: string | Date | null;
  valid_until?: string | Date | null;
  review_on?: string | Date | null;
  reviewed_at?: string | Date | null;
  versions?: Array<{lifecycle_state?: string | null}> | null;
};

export type DocumentClassification = {
  computed_status: DocumentStatusCategory;
  status_label: string;
  expiry_bucket: ExpiryBucket;
  days_until_expiry: number | null;
  review_state: ReviewState;
  has_available_version: boolean;
  is_approved: boolean;
  is_currently_valid: boolean;
  is_reviewed: boolean;
};

function dayValue(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function todayValue(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function expiryBucket(validUntil: string | Date | null | undefined, now = new Date()): {bucket: ExpiryBucket; days: number | null} {
  const until = dayValue(validUntil);
  if (until === null) return {bucket: 'no_expiry', days: null};
  const days = Math.round((until - todayValue(now)) / 86_400_000);
  if (days < 0) return {bucket: 'expired', days};
  if (days <= 7) return {bucket: 'within_7_days', days};
  if (days <= 30) return {bucket: 'within_8_30_days', days};
  if (days <= 60) return {bucket: 'within_31_60_days', days};
  return {bucket: 'beyond_60_days', days};
}

export function reviewState(document: ClassifiableDocument, now = new Date()): ReviewState {
  if (document.approval_status === 'pending_approval') return 'pending';
  const review = dayValue(document.review_on);
  if (review === null) return 'none';
  const reviewed = dayValue(document.reviewed_at);
  if (reviewed !== null && reviewed >= review) return 'none';
  const days = Math.round((review - todayValue(now)) / 86_400_000);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due_soon';
  return 'none';
}

export function classifyDocument(document: ClassifiableDocument, now = new Date()): DocumentClassification {
  const {bucket, days} = expiryBucket(document.valid_until, now);
  const review = reviewState(document, now);
  const hasAvailableVersion = (document.versions ?? []).some(
    version => version?.lifecycle_state === ('available' satisfies DmsLifecycleState),
  );
  const isApproved = document.approval_status === 'approved';
  const isReviewed = dayValue(document.reviewed_at) !== null;
  const from = dayValue(document.valid_from);
  const startsInFuture = from !== null && from > todayValue(now);
  const isCurrentlyValid = isApproved && hasAvailableVersion && !startsInFuture && bucket !== 'expired' && document.document_status !== 'deleted';

  let computed_status: DocumentStatusCategory;
  if (document.document_status === 'deleted' || document.approval_status === 'rejected' || document.approval_status === 'archived' || !hasAvailableVersion) {
    computed_status = 'nicht_freigegeben';
  } else if (document.approval_status === 'pending_approval' || review === 'overdue') {
    computed_status = 'pruefung_ausstehend';
  } else if (document.approval_status !== 'approved') {
    computed_status = 'nicht_freigegeben';
  } else if (startsInFuture) {
    computed_status = 'noch_nicht_gueltig';
  } else if (bucket === 'expired') {
    computed_status = 'abgelaufen';
  } else if (review === 'due_soon') {
    computed_status = 'bald_pruefpflichtig';
  } else if (bucket === 'within_7_days' || bucket === 'within_8_30_days') {
    computed_status = 'lauf_bald_ab';
  } else {
    computed_status = 'gueltig';
  }

  return {
    computed_status,
    status_label: documentStatusLabels[computed_status],
    expiry_bucket: bucket,
    days_until_expiry: days,
    review_state: review,
    has_available_version: hasAvailableVersion,
    is_approved: isApproved,
    is_currently_valid: isCurrentlyValid,
    is_reviewed: isReviewed,
  };
}

const statusPriority: Record<DocumentStatusCategory, number> = {
  gueltig: 0,
  lauf_bald_ab: 1,
  bald_pruefpflichtig: 2,
  noch_nicht_gueltig: 3,
  pruefung_ausstehend: 4,
  nicht_freigegeben: 5,
  abgelaufen: 6,
  fehlend: 7,
};

export type ClassifiedRequirement = {
  id: string;
  document_type: string;
  required: boolean;
  missing: boolean;
  requirement_status: DocumentStatusCategory;
  status_label: string;
  matching_document_id: string | null;
  // Present vs valid vs approved vs reviewed are deliberately separate facts.
  has_available_version: boolean;
  is_approved: boolean;
  is_currently_valid: boolean;
  is_reviewed: boolean;
  review_state: ReviewState;
  days_until_expiry: number | null;
};

/**
 * Derives one status per mandatory-document requirement. When several
 * documents match a type, the best (most usable) one determines the status.
 */
export function classifyRequirement<T extends {id: string; document_type: string; required?: boolean | null}>(
  requirement: T,
  documents: Array<ClassifiableDocument & {id: string}>,
  now = new Date(),
): ClassifiedRequirement {
  const classified = documents.map(document => ({document, status: classifyDocument(document, now)}));
  classified.sort((left, right) => statusPriority[left.status.computed_status] - statusPriority[right.status.computed_status]);
  const best = classified[0];
  const requirement_status: DocumentStatusCategory = best ? best.status.computed_status : 'fehlend';
  return {
    id: requirement.id,
    document_type: requirement.document_type,
    required: requirement.required !== false,
    missing: requirement.required !== false && !best,
    requirement_status,
    status_label: documentStatusLabels[requirement_status],
    matching_document_id: best?.document.id ?? null,
    has_available_version: best?.status.has_available_version ?? false,
    is_approved: best?.status.is_approved ?? false,
    is_currently_valid: best?.status.is_currently_valid ?? false,
    is_reviewed: best?.status.is_reviewed ?? false,
    review_state: best?.status.review_state ?? 'none',
    days_until_expiry: best?.status.days_until_expiry ?? null,
  };
}

/** Single-valued counts: every document is in exactly one status category. */
export function documentStatusCounts(documents: ClassifiableDocument[], now = new Date()): Record<DocumentStatusCategory, number> {
  const counts = Object.fromEntries(Object.keys(documentStatusLabels).map(key => [key, 0])) as Record<DocumentStatusCategory, number>;
  for (const document of documents) counts[classifyDocument(document, now).computed_status] += 1;
  return counts;
}

export function documentWarningCounts(documents: ClassifiableDocument[], now = new Date()) {
  const counts: Record<ExpiryBucket | 'unapproved' | 'review_pending' | 'no_expiry', number> = {
    expired: 0, within_7_days: 0, within_8_30_days: 0, within_31_60_days: 0,
    beyond_60_days: 0, no_expiry: 0, unapproved: 0, review_pending: 0,
  };
  for (const document of documents) {
    const status = classifyDocument(document, now);
    counts[status.expiry_bucket] += 1;
    if (status.computed_status === 'nicht_freigegeben') counts.unapproved += 1;
    if (status.review_state === 'overdue' || status.review_state === 'pending') counts.review_pending += 1;
  }
  return counts;
}
