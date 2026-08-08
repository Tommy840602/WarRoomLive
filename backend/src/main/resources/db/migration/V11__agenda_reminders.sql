-- Telling a room when something's time has come, exactly once.
--
-- The agenda has had due times since V9 and triage since V10, and nothing has
-- ever acted on either: the time arrived, the row went red, and if nobody had
-- the panel open nobody knew. A deadline that only exists while you are looking
-- at it is a deadline the tool is not keeping for you.
--
-- `reminded_at` is what makes the sweep idempotent. Without it a scheduler
-- either re-announces the same item every pass, or has to remember what it has
-- said in memory — which survives neither a restart nor a second node. Written
-- in the same transaction as the announcement, so the two cannot disagree.
--
-- Nullable, and NULL means "not yet". Backfilling it to now() would be wrong in
-- the other direction: every already-overdue item would be silently marked as
-- announced and nobody would ever hear about it.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

-- The sweep asks "due before now, not yet announced, not finished" every
-- minute. Without an index that is a full scan of both tables per pass, for a
-- query whose answer is almost always empty.
CREATE INDEX IF NOT EXISTS idx_todos_due_pending
    ON todos (due_at)
    WHERE reminded_at IS NULL AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_start_pending
    ON calendar_events (starts_at)
    WHERE reminded_at IS NULL AND completed_at IS NULL;
