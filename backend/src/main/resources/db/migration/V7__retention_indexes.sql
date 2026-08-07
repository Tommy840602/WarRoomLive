-- Indexes the retention sweep needs. Every existing index on these tables is
-- keyed by room or aggregate first, so an age predicate could only be answered
-- by a full scan — fine for a table with a thousand rows, not for the tables
-- this job exists to keep from growing forever.
--
-- Each is the plain age column, matching the sweep's predicate exactly.
CREATE INDEX IF NOT EXISTS chat_message_ts ON chat_message (ts);

CREATE INDEX IF NOT EXISTS recordings_ended ON recordings (ended_at);

CREATE INDEX IF NOT EXISTS audit_occurred ON audit_log (occurred_at);

CREATE INDEX IF NOT EXISTS message_search_ts ON message_search (ts);

-- Partial: only published rows are ever eligible for deletion — unpublished ones
-- are the queue, and the existing outbox_unpublished index already serves those.
CREATE INDEX IF NOT EXISTS outbox_published ON outbox_events (published_at)
    WHERE published_at IS NOT NULL;
