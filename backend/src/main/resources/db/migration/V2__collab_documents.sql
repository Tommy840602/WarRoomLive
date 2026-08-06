-- Shared-notes persistence used by the collab service (Hocuspocus): latest
-- merged snapshot per document plus the durable incremental update log that is
-- replayed over it and trimmed on compaction. Flyway owns the canonical
-- definition; the collab service keeps idempotent CREATE IF NOT EXISTS
-- statements only as a fallback for running without the backend.
CREATE TABLE IF NOT EXISTS collab_document (
    name       text PRIMARY KEY,
    data       bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collab_update (
    id         bigserial PRIMARY KEY,
    name       text NOT NULL,
    data       bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_update_name_id ON collab_update (name, id);
