export type SqliteFileStateErrorCategory =
    | 'contention'
    | 'readonly'
    | 'inaccessible'
    | 'full'
    | 'io'
    | 'corrupt'
    | 'schema'
    | 'protocol'
    | 'foreign-key'
    | 'malformed-state'
    | 'counter'
    | 'recovery'
    | 'commit'
    | 'unsupported'
    | 'unknown';

export interface SqliteFileStateErrorMetadata {
    readonly sqliteCode?: string;
    readonly sqliteErrorCode?: number;
    readonly sqlitePrimaryCode?: number;
    readonly operation?: string;
    readonly schemaVersion?: number;
    readonly protocol?: number;
    readonly coordinationGeneration?: number;
    readonly rowCount?: number;
}

interface NodeSqliteErrorLike {
    readonly code?: unknown;
    readonly errcode?: unknown;
}

const SQLITE_ERROR_NAMES: Readonly<Record<number, string>> = {
    3: 'SQLITE_PERM',
    5: 'SQLITE_BUSY',
    6: 'SQLITE_LOCKED',
    8: 'SQLITE_READONLY',
    10: 'SQLITE_IOERR',
    11: 'SQLITE_CORRUPT',
    13: 'SQLITE_FULL',
    14: 'SQLITE_CANTOPEN',
    15: 'SQLITE_PROTOCOL',
    17: 'SQLITE_SCHEMA',
    19: 'SQLITE_CONSTRAINT',
    23: 'SQLITE_AUTH',
    26: 'SQLITE_NOTADB',
};

const CATEGORY_MESSAGES: Readonly<Record<SqliteFileStateErrorCategory, string>> = {
    contention: 'The SQLite file-state database is busy, locked, or incompatible with the active locking protocol.',
    readonly: 'The SQLite file-state database is read-only.',
    inaccessible: 'The SQLite file-state database cannot be opened with the required permissions.',
    full: 'The SQLite file-state change could not be committed because storage is full.',
    io: 'The SQLite file-state database encountered an I/O failure.',
    corrupt: 'The SQLite file-state database is corrupt or is not a SQLite database.',
    schema: 'The SQLite file-state schema or application identity is unsupported.',
    protocol: 'The SQLite file-state coordination protocol is unsupported.',
    'foreign-key': 'The SQLite file-state database contains an invalid foreign-key relationship.',
    'malformed-state': 'The SQLite file-state database contains malformed persisted state.',
    counter: 'The SQLite file-state database contains an invalid or exhausted counter.',
    recovery: 'The SQLite file-state database requires explicit recovery.',
    commit: 'The SQLite file-state commit outcome could not be established safely.',
    unsupported: 'The required SQLite file-state durability operation is unsupported on this filesystem.',
    unknown: 'The SQLite file-state operation failed.',
};

function safe_optional_integer(value: unknown): number | undefined {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function sanitize_metadata(
    metadata: SqliteFileStateErrorMetadata | undefined,
): SqliteFileStateErrorMetadata {
    if (!metadata) return {};
    const result: {
        sqliteCode?: string;
        sqliteErrorCode?: number;
        sqlitePrimaryCode?: number;
        operation?: string;
        schemaVersion?: number;
        protocol?: number;
        coordinationGeneration?: number;
        rowCount?: number;
    } = {};
    if (/^[A-Z0-9_]+$/.test(metadata.sqliteCode ?? '')) result.sqliteCode = metadata.sqliteCode;
    for (const key of [
        'sqliteErrorCode',
        'sqlitePrimaryCode',
        'schemaVersion',
        'protocol',
        'coordinationGeneration',
        'rowCount',
    ] as const) {
        const value = safe_optional_integer(metadata[key]);
        if (value !== undefined) result[key] = value;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(metadata.operation ?? '')) {
        result.operation = metadata.operation;
    }
    return result;
}

export class SqliteFileStateError extends Error {
    readonly category: SqliteFileStateErrorCategory;
    readonly metadata: Readonly<SqliteFileStateErrorMetadata>;

    constructor(
        category: SqliteFileStateErrorCategory,
        metadata?: SqliteFileStateErrorMetadata,
    ) {
        super(CATEGORY_MESSAGES[category]);
        this.name = 'SqliteFileStateError';
        this.category = category;
        this.metadata = Object.freeze(sanitize_metadata(metadata));
    }
}

export function sqlite_file_state_error(
    category: SqliteFileStateErrorCategory,
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError {
    return new SqliteFileStateError(category, metadata);
}

/**
 * Conservatively classify only SQLite result codes whose recovery policy is known.
 * Error messages, SQL text, bound parameters, paths, and row payloads are never copied.
 */
export function categorize_sqlite_file_state_error(
    error: unknown,
    metadata?: Omit<SqliteFileStateErrorMetadata, 'sqliteCode' | 'sqliteErrorCode' | 'sqlitePrimaryCode'>,
): SqliteFileStateError {
    if (error instanceof SqliteFileStateError) return error;
    const candidate = error as NodeSqliteErrorLike | null;
    const extended = typeof candidate?.errcode === 'number' && Number.isInteger(candidate.errcode)
        ? candidate.errcode
        : undefined;
    const primary = extended === undefined ? undefined : extended & 0xff;
    const code = typeof candidate?.code === 'string' && /^[A-Z0-9_]+$/.test(candidate.code)
        ? candidate.code
        : undefined;
    let category: SqliteFileStateErrorCategory = 'unknown';
    switch (primary) {
        case 5:
        case 6:
        case 15:
            category = 'contention';
            break;
        case 8:
            category = 'readonly';
            break;
        case 3:
        case 14:
        case 23:
            category = 'inaccessible';
            break;
        case 13:
            category = 'full';
            break;
        case 10:
            category = 'io';
            break;
        case 11:
        case 26:
            category = 'corrupt';
            break;
        case 17:
            category = 'schema';
            break;
        case 19:
            // SQLITE_CONSTRAINT_FOREIGNKEY is extended code 787.
            category = extended === 787 ? 'foreign-key' : 'unknown';
            break;
    }
    return new SqliteFileStateError(category, {
        ...metadata,
        sqliteCode: primary === undefined ? code : SQLITE_ERROR_NAMES[primary] ?? code,
        sqliteErrorCode: extended,
        sqlitePrimaryCode: primary,
    });
}

export const sqlite_file_state_schema_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('schema', metadata);

export const sqlite_file_state_protocol_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('protocol', metadata);

export const sqlite_file_state_foreign_key_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('foreign-key', metadata);

export const sqlite_file_state_malformed_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('malformed-state', metadata);

export const sqlite_file_state_counter_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('counter', metadata);

export const sqlite_file_state_recovery_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('recovery', metadata);

export const sqlite_file_state_commit_error = (
    metadata?: SqliteFileStateErrorMetadata,
): SqliteFileStateError => new SqliteFileStateError('commit', metadata);
