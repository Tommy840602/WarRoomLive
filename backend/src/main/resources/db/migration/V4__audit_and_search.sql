-- Read models built by the indexer service from warroom.events (events overlay).
-- audit_log keeps every event; message_search is the full-text read model for
-- chat. event_id primary keys make consumption idempotent: redeliveries from the
-- at-least-once pipeline hit ON CONFLICT DO NOTHING.
-- PostgreSQL FTS is the pragmatic first step; the blueprint's OpenSearch replaces
-- it when cross-project search outgrows this (both are rebuildable projections).
CREATE TABLE IF NOT EXISTS audit_log (
    event_id       uuid PRIMARY KEY,
    event_type     varchar(100) NOT NULL,
    aggregate_type varchar(50)  NOT NULL,
    aggregate_id   varchar(255) NOT NULL,
    schema_version int          NOT NULL,
    payload        jsonb        NOT NULL,
    occurred_at    timestamptz  NOT NULL,
    indexed_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_by_aggregate ON audit_log (aggregate_type, aggregate_id, occurred_at);

CREATE TABLE IF NOT EXISTS message_search (
    event_id uuid PRIMARY KEY,
    room     varchar(255)  NOT NULL,
    from_id  varchar(255)  NOT NULL,
    name     varchar(255)  NOT NULL,
    text     varchar(4000) NOT NULL,
    ts       bigint        NOT NULL,
    tsv      tsvector      NOT NULL
);

CREATE INDEX IF NOT EXISTS message_search_tsv ON message_search USING gin (tsv);
CREATE INDEX IF NOT EXISTS message_search_room ON message_search (room, ts);
