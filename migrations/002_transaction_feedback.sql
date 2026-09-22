CREATE TABLE IF NOT EXISTS transaction_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    transaction_id TEXT NOT NULL,
    transaction_type TEXT NOT NULL,

    receipt_status TEXT NOT NULL DEFAULT 'NONE',

    rating INTEGER,
    review TEXT,

    complaint_status TEXT NOT NULL DEFAULT 'NONE',
    complaint_message TEXT,

    received_at TEXT,
    complaint_at TEXT,
    reviewed_at TEXT,

    complaint_admin_read INTEGER NOT NULL DEFAULT 0,
    complaint_admin_read_at TEXT,

    review_admin_read INTEGER NOT NULL DEFAULT 0,
    review_admin_read_at TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE(user_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_user
ON transaction_feedback(user_id);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_transaction
ON transaction_feedback(transaction_id);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_complaint
ON transaction_feedback(complaint_status);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_complaint_read
ON transaction_feedback(complaint_admin_read);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_review_read
ON transaction_feedback(review_admin_read);

CREATE INDEX IF NOT EXISTS idx_transaction_feedback_created
ON transaction_feedback(created_at);
