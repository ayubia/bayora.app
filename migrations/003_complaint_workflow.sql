ALTER TABLE transaction_feedback
ADD COLUMN complaint_resolved_at TEXT;

ALTER TABLE transaction_feedback
ADD COLUMN complaint_status_updated_at TEXT;

ALTER TABLE transaction_feedback
ADD COLUMN complaint_status_updated_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_complaint_status
ON transaction_feedback(complaint_status);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_resolved
ON transaction_feedback(complaint_resolved_at);
