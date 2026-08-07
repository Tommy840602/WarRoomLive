-- Chandler-style triage, and completion for calendar entries.
--
-- Chandler's insight was that a to-do and a calendar entry are not two kinds of
-- thing. What separates them is which facets an item carries — an owner, a
-- time, a span — not which list it was filed into. This migration gives both
-- tables the two columns they were missing to be the same thing.
--
-- `triage` is the item's section on the dashboard: NOW, LATER or DONE. It is
-- NULL by default, and NULL is not "unset" so much as "the clock decides" —
-- an item auto-triages from its due time until somebody disagrees, at which
-- point their decision is stored here and stops moving on its own. That is the
-- whole point of the column: the clock proposes, the room disposes, and the
-- disagreement has to survive a reload or it was never a decision.
--
-- DONE is deliberately NOT stored here. Completion already has a home in
-- `todos` (a time and an author, so "who closed it" is answerable), and this
-- migration gives calendar entries the same pair. Storing "done" twice is how
-- the two copies end up disagreeing.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS triage varchar(8);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS triage varchar(8);

-- Same shape as `todos`: both null or both set.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS completed_by varchar(255);
