-- Transactional outbox (kafka profile): business events are written in the same
-- transaction as their aggregate, then shipped to the broker by a polling
-- publisher (at-least-once; consumers dedupe on event_id). Rows are kept after
-- publishing (published_at set) as a short-term audit trail.
CREATE TABLE IF NOT EXISTS outbox_events (
    id             bigserial PRIMARY KEY,
    event_id       uuid         NOT NULL UNIQUE,
    event_type     varchar(100) NOT NULL,
    aggregate_type varchar(50)  NOT NULL,
    aggregate_id   varchar(255) NOT NULL,
    schema_version int          NOT NULL DEFAULT 1,
    payload        jsonb        NOT NULL,
    occurred_at    timestamptz  NOT NULL DEFAULT now(),
    published_at   timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox_events (id) WHERE published_at IS NULL;
