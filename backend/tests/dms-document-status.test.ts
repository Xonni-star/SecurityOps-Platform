import {describe,expect,it} from '@jest/globals';
import {
  classifyDocument,
  classifyRequirement,
  documentStatusCounts,
  documentWarningCounts,
  expiryBucket,
  type ClassifiableDocument,
} from '../src/services/dms-document-status.js';

const now = new Date('2026-01-01T00:00:00Z');
const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

function document(overrides: Partial<ClassifiableDocument> = {}): ClassifiableDocument {
  return {
    document_status: 'active',
    approval_status: 'approved',
    valid_from: '2025-01-01',
    valid_until: null,
    review_on: null,
    versions: [{lifecycle_state: 'available'}],
    ...overrides,
  };
}

describe('DMS document status classification', () => {
  it('uses mutually exclusive expiry buckets at every boundary', () => {
    expect(expiryBucket(day(-1), now)).toEqual({bucket: 'expired', days: -1});
    expect(expiryBucket(day(0), now)).toEqual({bucket: 'within_7_days', days: 0});
    expect(expiryBucket(day(7), now)).toEqual({bucket: 'within_7_days', days: 7});
    expect(expiryBucket(day(8), now)).toEqual({bucket: 'within_8_30_days', days: 8});
    expect(expiryBucket(day(30), now)).toEqual({bucket: 'within_8_30_days', days: 30});
    expect(expiryBucket(day(31), now)).toEqual({bucket: 'within_31_60_days', days: 31});
    expect(expiryBucket(day(60), now)).toEqual({bucket: 'within_31_60_days', days: 60});
    expect(expiryBucket(day(61), now)).toEqual({bucket: 'beyond_60_days', days: 61});
    expect(expiryBucket(null, now)).toEqual({bucket: 'no_expiry', days: null});
  });

  it('classifies valid, expiring, expired and no-expiry documents once', () => {
    expect(classifyDocument(document(), now).computed_status).toBe('gueltig');
    expect(classifyDocument(document({valid_until: day(5)}), now).computed_status).toBe('lauf_bald_ab');
    expect(classifyDocument(document({valid_until: day(20)}), now).computed_status).toBe('lauf_bald_ab');
    expect(classifyDocument(document({valid_until: day(-1)}), now).computed_status).toBe('abgelaufen');
    expect(classifyDocument(document({valid_until: null}), now).expiry_bucket).toBe('no_expiry');
  });

  it('distinguishes unapproved, pending review, overdue review and future validity', () => {
    expect(classifyDocument(document({approval_status: 'draft'}), now).computed_status).toBe('nicht_freigegeben');
    expect(classifyDocument(document({approval_status: 'pending_approval'}), now).computed_status).toBe('pruefung_ausstehend');
    expect(classifyDocument(document({review_on: day(-1)}), now).computed_status).toBe('pruefung_ausstehend');
    expect(classifyDocument(document({review_on: day(14)}), now).computed_status).toBe('bald_pruefpflichtig');
    expect(classifyDocument(document({valid_from: day(2)}), now).computed_status).toBe('noch_nicht_gueltig');
  });

  it('never counts a document without a released binary as usable', () => {
    const quarantined = classifyDocument(document({versions: [{lifecycle_state: 'quarantined'}]}), now);
    expect(quarantined.computed_status).toBe('nicht_freigegeben');
    expect(quarantined.has_available_version).toBe(false);
    expect(quarantined.is_currently_valid).toBe(false);
  });

  it('uses the most usable matching document for a mandatory requirement', () => {
    const requirement = {id: 'requirement-1', document_type: 'Security Plan', required: true};
    const result = classifyRequirement(
      requirement,
      [
        {id: 'expired-doc', ...document({valid_until: day(-1)})},
        {id: 'valid-doc', ...document({valid_until: day(90)})},
      ],
      now,
    );
    expect(result.missing).toBe(false);
    expect(result.requirement_status).toBe('gueltig');
    expect(result.matching_document_id).toBe('valid-doc');
    expect(classifyRequirement(requirement, [], now)).toMatchObject({missing: true, requirement_status: 'fehlend'});
  });

  it('keeps reviewed, approved and valid as separate facts', () => {
    const reviewed = classifyDocument(document({review_on: day(-5), reviewed_at: day(-4)}), now);
    expect(reviewed.review_state).toBe('none');
    expect(reviewed.computed_status).toBe('gueltig');
    expect(reviewed.is_reviewed).toBe(true);
    expect(reviewed.is_approved).toBe(true);
    expect(reviewed.is_currently_valid).toBe(true);

    const unreviewed = classifyDocument(document({review_on: day(-5)}), now);
    expect(unreviewed.review_state).toBe('overdue');
    expect(unreviewed.computed_status).toBe('pruefung_ausstehend');
    expect(unreviewed.is_reviewed).toBe(false);
  });

  it('exposes requirement details instead of collapsing them into one status', () => {
    const requirement = {id: 'requirement-2', document_type: 'Notfallplan', required: true};
    const result = classifyRequirement(
      requirement,
      [{id: 'draft-doc', ...document({approval_status: 'draft', valid_until: day(4)})}],
      now,
    );
    expect(result).toMatchObject({
      missing: false,
      has_available_version: true,
      is_approved: false,
      is_currently_valid: false,
      is_reviewed: false,
      review_state: 'none',
      days_until_expiry: 4,
    });
    expect(classifyRequirement(requirement, [], now)).toMatchObject({
      missing: true,
      has_available_version: false,
      is_approved: false,
      is_currently_valid: false,
      is_reviewed: false,
    });
  });

  it('counts each document in exactly one status category', () => {
    const documents = [
      document(),
      document({valid_until: day(3)}),
      document({review_on: day(-1)}),
      document({approval_status: 'draft'}),
      document({valid_until: day(-1)}),
    ];
    expect(documentStatusCounts(documents, now)).toEqual({
      gueltig: 1, lauf_bald_ab: 1, bald_pruefpflichtig: 0, abgelaufen: 1,
      fehlend: 0, nicht_freigegeben: 1, pruefung_ausstehend: 1, noch_nicht_gueltig: 0,
    });
    expect(Object.values(documentStatusCounts(documents, now)).reduce((sum, value) => sum + value, 0)).toBe(documents.length);
  });

  it('counts warnings without double counting a document', () => {
    const documents = [
      document({valid_until: day(-1)}),
      document({valid_until: day(7)}),
      document({valid_until: day(30)}),
      document({valid_until: day(60)}),
      document({valid_until: day(61)}),
      document({approval_status: 'draft', valid_until: day(3)}),
    ];
    expect(documentWarningCounts(documents, now)).toEqual({
      expired: 1, within_7_days: 2, within_8_30_days: 1, within_31_60_days: 1,
      beyond_60_days: 1, no_expiry: 0, unapproved: 1, review_pending: 0,
    });
  });
});
