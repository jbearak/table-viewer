/**
 * The `entries` table exactly as v0.8.0 shipped it, pinned as a fixture.
 *
 * Copied verbatim from `git show v0.8.0:src/sqlite-file-state-schema.ts` so it
 * cannot drift when the live schema is edited — a test that built this from the
 * current source would pass no matter what changed, which is the whole failure
 * mode being guarded against. See `entries` in `sqlite-file-state-schema.ts`.
 */
export const V0_8_ENTRIES_TABLE_SQL = `\
CREATE TABLE entries (
    path                       TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    state_revision             INTEGER NOT NULL
                               CHECK (state_revision BETWEEN 0 AND 9007199254740990),
    state_json                 TEXT NOT NULL
                               CHECK (json_valid(state_json))
                               CHECK (json_type(state_json) = 'object'),
    has_pending_edits          INTEGER NOT NULL
                               CHECK (has_pending_edits IN (0, 1)),

    authority_commit_sequence  INTEGER NOT NULL
                               CHECK (authority_commit_sequence BETWEEN 0 AND 9007199254740990),
    authority_revision         INTEGER NOT NULL
                               CHECK (authority_revision BETWEEN 0 AND 9007199254740990),
    physical_revision          INTEGER NOT NULL
                               CHECK (physical_revision BETWEEN 0 AND 9007199254740990),
    projection_revision        INTEGER NOT NULL
                               CHECK (projection_revision BETWEEN 0 AND 9007199254740990),
    physical_digest            TEXT,

    recency_order              INTEGER NOT NULL CHECK (recency_order >= 1),
    updated_at_ms              INTEGER
                               CHECK (updated_at_ms IS NULL OR updated_at_ms >= 0),
    touched_at_ms              INTEGER
                               CHECK (touched_at_ms IS NULL OR touched_at_ms >= 0),

    recovery_entry_id          TEXT NOT NULL COLLATE BINARY UNIQUE,
    recovery_record_id         TEXT COLLATE BINARY,

    copy_id                    TEXT,
    copy_source_path           TEXT COLLATE BINARY,
    copy_source_revision       INTEGER
                               CHECK (
                                   copy_source_revision IS NULL
                                   OR copy_source_revision BETWEEN 0 AND 9007199254740990
                               ),

    CHECK (
        (has_pending_edits = 0
            AND json_type(state_json, '$.pendingEdits') IS NULL)
        OR
        (has_pending_edits = 1
            AND json_type(state_json, '$.pendingEdits') = 'object')
    ),
    CHECK (
        (copy_id IS NULL
            AND copy_source_path IS NULL
            AND copy_source_revision IS NULL)
        OR
        (copy_id IS NOT NULL
            AND copy_source_path IS NOT NULL
            AND copy_source_revision IS NOT NULL)
    )
) STRICT, WITHOUT ROWID`;
