-- Allows maintenance order creation to use the shared idempotency receipts.
-- The action list is cumulative; previous actions remain valid.
ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost',
    'keys.deactivate','handover.create','handover.participant',
    'handover.confirm','handover.revoke','handover.correct',
    'keys.bundle.create','keys.bundle.item','keys.bundle.issue',
    'keys.bundle.return','maintenance.order.create'
  ));
