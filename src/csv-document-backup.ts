import { constants as BUFFER_CONSTANTS } from 'buffer';
import type { ResourceIdentity } from './resource-identity';
import { csv_content_digest, type CsvTargetBasis } from './csv-save-service';
import { MAX_CSV_ROWS } from './spreadsheet-safety';
import type { CsvDirtyEntry } from './types';

const MAGIC = Uint8Array.from([0x54, 0x56, 0x43, 0x53, 0x56, 0x42, 0x4b, 0x00]);
const VERSION = 2;
const PREFIX_BYTES = 24;
const ENTRY_PREFIX_BYTES = 12;
const MEBIBYTE = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_DIRTY_ENTRIES = 1_000_000;
const DEFAULT_MAX_ENTRY_BYTES = 16 * MEBIBYTE;
const BACKUP_EXTRA_BYTES = 64 * MEBIBYTE;
const UINT32_MAX = 0xffff_ffff;

// These ceilings are part of the V2 recovery contract. Mutable workspace settings
// can lower admission for new documents, but an untrusted backup cannot raise any
// recovery allocation above these immutable format-version budgets.
export const CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES = Math.min(
    256 * MEBIBYTE,
    UINT32_MAX,
    BUFFER_CONSTANTS.MAX_LENGTH,
);
const V2_MAX_DIRTY_ENTRIES = Math.min(DEFAULT_MAX_DIRTY_ENTRIES, UINT32_MAX);
const V2_MAX_ENTRY_BYTES = Math.min(DEFAULT_MAX_ENTRY_BYTES, UINT32_MAX);
const V2_MAX_DIRTY_SECTION_BYTES = 64 * MEBIBYTE;
export const CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES = Math.min(
    BUFFER_CONSTANTS.MAX_LENGTH,
    CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES
        + V2_MAX_DIRTY_SECTION_BYTES
        + MAX_HEADER_BYTES
        + PREFIX_BYTES,
);

export interface CsvDocumentRecoveryLimits {
    readonly maxSourceBytes: number;
    readonly maxRows: number;
}

interface BackupHeaderV2 {
    readonly resourceKey: string;
    readonly resource: {
        readonly scheme: string;
        readonly authority: string;
        readonly path: string;
        readonly query: string;
    };
    readonly delimiter: ',' | '\t';
    readonly targetBasis: CsvTargetBasis;
    readonly sourceDigest: string;
    readonly recoveryLimits: CsvDocumentRecoveryLimits;
}

export interface CsvDocumentBackupLimits {
    readonly maxSourceBytes: number;
    readonly maxBackupBytes?: number;
    readonly maxDirtyEntries?: number;
    readonly maxEntryBytes?: number;
}

export interface CsvDocumentBackupEnvelopeInput {
    readonly identity: ResourceIdentity;
    readonly delimiter: ',' | '\t';
    readonly targetBasis: CsvTargetBasis;
    readonly sourceBytes: Uint8Array;
    readonly maxRows: number;
    readonly limits: CsvDocumentBackupLimits;
}

export interface EncodeCsvDocumentBackupInput extends CsvDocumentBackupEnvelopeInput {
    readonly dirtyEntries: ReadonlyMap<string, CsvDirtyEntry>;
}

/** Precomputed fixed envelope cost and limits used to admit edits without encoding a backup. */
export interface CsvDocumentBackupBudget {
    readonly fixedBytes: number;
    readonly maxBackupBytes: number;
    readonly maxDirtyEntries: number;
    readonly maxEntryBytes: number;
    readonly maxDirtySectionBytes: number;
}

export type CsvDocumentDirtyEntryValidator = (
    key: string,
    entry: CsvDirtyEntry,
) => void;

export interface DecodedCsvDocumentBackupEnvelope {
    readonly version: 2;
    readonly delimiter: ',' | '\t';
    readonly targetBasis: CsvTargetBasis;
    readonly sourceDigest: string;
    readonly sourceBytes: Uint8Array;
    readonly dirtyCount: number;
    readonly recoveryLimits: CsvDocumentRecoveryLimits;
    decodeDirtyEntries(
        validate?: CsvDocumentDirtyEntryValidator,
    ): ReadonlyMap<string, CsvDirtyEntry>;
}

export interface DecodedCsvDocumentBackup {
    readonly version: 2;
    readonly delimiter: ',' | '\t';
    readonly targetBasis: CsvTargetBasis;
    readonly sourceDigest: string;
    readonly sourceBytes: Uint8Array;
    readonly dirtyEntries: ReadonlyMap<string, CsvDirtyEntry>;
    readonly recoveryLimits: CsvDocumentRecoveryLimits;
}

export type CsvDocumentBackupErrorCode =
    | 'malformed'
    | 'unsupportedVersion'
    | 'resourceMismatch'
    | 'sizeLimit'
    | 'countLimit'
    | 'digestMismatch';

export class CsvDocumentBackupError extends Error {
    readonly code: CsvDocumentBackupErrorCode;
    override readonly cause?: unknown;

    constructor(code: CsvDocumentBackupErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'CsvDocumentBackupError';
        this.code = code;
        this.cause = cause;
    }
}

interface ResolvedLimits {
    readonly maxSourceBytes: number;
    readonly maxBackupBytes: number;
    readonly maxDirtyEntries: number;
    readonly maxEntryBytes: number;
}

interface PreparedBackupEnvelope {
    readonly budget: CsvDocumentBackupBudget;
    readonly headerBytes: Uint8Array;
}

function bounded_integer(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function resolve_limits(limits: CsvDocumentBackupLimits): ResolvedLimits {
    const max_source_bytes = Math.min(
        bounded_integer(limits.maxSourceBytes, 'maxSourceBytes'),
        CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
    );
    const default_backup_bytes = Math.min(
        CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES,
        max_source_bytes + Math.max(max_source_bytes, BACKUP_EXTRA_BYTES),
    );
    return {
        maxSourceBytes: max_source_bytes,
        maxBackupBytes: Math.min(
            bounded_integer(
                limits.maxBackupBytes ?? default_backup_bytes,
                'maxBackupBytes',
            ),
            CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES,
        ),
        maxDirtyEntries: Math.min(
            bounded_integer(
                limits.maxDirtyEntries ?? DEFAULT_MAX_DIRTY_ENTRIES,
                'maxDirtyEntries',
            ),
            V2_MAX_DIRTY_ENTRIES,
        ),
        maxEntryBytes: Math.min(
            bounded_integer(
                limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
                'maxEntryBytes',
            ),
            V2_MAX_ENTRY_BYTES,
        ),
    };
}

function is_digest(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function create_recovery_limits(
    max_source_bytes: number,
    max_rows: number,
): CsvDocumentRecoveryLimits {
    const rows = bounded_integer(max_rows, 'maxRows');
    if (rows > MAX_CSV_ROWS) {
        throw new CsvDocumentBackupError(
            'countLimit',
            'CSV backup row admission exceeds the runtime row limit.',
        );
    }
    return Object.freeze({ maxSourceBytes: max_source_bytes, maxRows: rows });
}

function validate_recovery_limits(value: unknown): CsvDocumentRecoveryLimits {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup recovery limits are invalid.');
    }
    const limits = value as { maxSourceBytes?: unknown; maxRows?: unknown };
    if (
        !Number.isSafeInteger(limits.maxSourceBytes)
        || (limits.maxSourceBytes as number) < 0
        || !Number.isSafeInteger(limits.maxRows)
        || (limits.maxRows as number) < 0
    ) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup recovery limits are invalid.');
    }
    if (
        (limits.maxSourceBytes as number) > CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES
        || (limits.maxRows as number) > MAX_CSV_ROWS
    ) {
        throw new CsvDocumentBackupError(
            'sizeLimit',
            'CSV backup recovery limits exceed runtime hard limits.',
        );
    }
    return Object.freeze({
        maxSourceBytes: limits.maxSourceBytes as number,
        maxRows: limits.maxRows as number,
    });
}

function is_cell_key(value: string): boolean {
    const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
    return match !== null
        && Number.isSafeInteger(Number(match[1]))
        && Number.isSafeInteger(Number(match[2]));
}

function checked_add(total: number, value: number, limit: number): number {
    const next = total + value;
    if (!Number.isSafeInteger(next) || next > limit) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup exceeds its size limit.');
    }
    return next;
}

function validate_target_basis(value: unknown): CsvTargetBasis {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup target basis is invalid.');
    }
    const basis = value as { stat?: { size?: unknown; mtime?: unknown }; digest?: unknown };
    if (
        !basis.stat
        || !Number.isSafeInteger(basis.stat.size)
        || (basis.stat.size as number) < 0
        || typeof basis.stat.mtime !== 'number'
        || !Number.isFinite(basis.stat.mtime)
        || !is_digest(basis.digest)
    ) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup target basis is invalid.');
    }
    return Object.freeze({
        stat: Object.freeze({ size: basis.stat.size as number, mtime: basis.stat.mtime }),
        digest: basis.digest,
    });
}

function decode_utf8(
    decoder: TextDecoder,
    bytes: Uint8Array,
    label: string,
): string {
    try {
        return decoder.decode(bytes);
    } catch (error) {
        throw new CsvDocumentBackupError('malformed', `${label} is not valid UTF-8.`, error);
    }
}

function serialize_backup_string(value: string): string {
    // JSON's escaped surrogate representation preserves every JavaScript string
    // code unit. Encoding the string directly as UTF-8 would silently replace a
    // lone surrogate with U+FFFD and corrupt hot-exit recovery.
    return JSON.stringify(value);
}

function decode_backup_string(
    decoder: TextDecoder,
    bytes: Uint8Array,
    label: string,
): string {
    let value: unknown;
    try {
        value = JSON.parse(decode_utf8(decoder, bytes, label));
    } catch (error) {
        if (error instanceof CsvDocumentBackupError) throw error;
        throw new CsvDocumentBackupError('malformed', `${label} is invalid.`, error);
    }
    if (typeof value !== 'string') {
        throw new CsvDocumentBackupError('malformed', `${label} is invalid.`);
    }
    return value;
}

function prepare_backup_envelope(
    input: CsvDocumentBackupEnvelopeInput,
    verify_source_digest: boolean,
): PreparedBackupEnvelope {
    const limits = resolve_limits(input.limits);
    const recovery_limits = create_recovery_limits(limits.maxSourceBytes, input.maxRows);
    if (input.delimiter !== ',' && input.delimiter !== '\t') {
        throw new CsvDocumentBackupError('malformed', 'CSV backup delimiter is invalid.');
    }
    if (
        input.sourceBytes.byteLength > limits.maxSourceBytes
        || input.sourceBytes.byteLength > UINT32_MAX
    ) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup source exceeds its size limit.');
    }
    const target_basis = validate_target_basis(input.targetBasis);
    const source_digest = verify_source_digest
        ? csv_content_digest(input.sourceBytes)
        : target_basis.digest;
    if (
        target_basis.stat.size !== input.sourceBytes.byteLength
        || target_basis.digest !== source_digest
    ) {
        throw new CsvDocumentBackupError(
            'malformed',
            'CSV backup target basis does not describe its source bytes.',
        );
    }
    const header: BackupHeaderV2 = {
        resourceKey: input.identity.key,
        resource: {
            scheme: input.identity.uri.scheme,
            authority: input.identity.uri.authority,
            path: input.identity.uri.path,
            query: input.identity.uri.query,
        },
        delimiter: input.delimiter,
        targetBasis: target_basis,
        sourceDigest: source_digest,
        recoveryLimits: recovery_limits,
    };
    const header_bytes = new TextEncoder().encode(JSON.stringify(header));
    if (header_bytes.byteLength > MAX_HEADER_BYTES) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup header exceeds its size limit.');
    }
    const max_backup_bytes = limits.maxBackupBytes;
    let fixed_bytes = PREFIX_BYTES;
    fixed_bytes = checked_add(fixed_bytes, header_bytes.byteLength, max_backup_bytes);
    fixed_bytes = checked_add(fixed_bytes, input.sourceBytes.byteLength, max_backup_bytes);
    return {
        budget: Object.freeze({
            fixedBytes: fixed_bytes,
            maxBackupBytes: max_backup_bytes,
            maxDirtyEntries: limits.maxDirtyEntries,
            maxEntryBytes: limits.maxEntryBytes,
            maxDirtySectionBytes: Math.min(
                V2_MAX_DIRTY_SECTION_BYTES,
                max_backup_bytes - fixed_bytes,
            ),
        }),
        headerBytes: header_bytes,
    };
}

export function create_csv_document_backup_budget(
    input: CsvDocumentBackupEnvelopeInput,
): CsvDocumentBackupBudget {
    // Budgeting is used on the live edit path. Its target basis was already
    // produced by a stable read or prepared content digest, so do not re-hash the
    // entire source merely to account for the fixed-size digest field.
    return prepare_backup_envelope(input, false).budget;
}

export function csv_document_backup_entry_size(
    key: string,
    entry: CsvDirtyEntry,
    budget: CsvDocumentBackupBudget,
): number {
    if (
        !is_cell_key(key)
        || typeof entry.value !== 'string'
        || typeof entry.base !== 'string'
        || entry.value === entry.base
    ) {
        throw new CsvDocumentBackupError('malformed', `CSV backup dirty entry ${key} is invalid.`);
    }
    const key_bytes = Buffer.byteLength(key, 'utf8');
    const value_bytes = Buffer.byteLength(serialize_backup_string(entry.value), 'utf8');
    const base_bytes = Buffer.byteLength(serialize_backup_string(entry.base), 'utf8');
    if (
        key_bytes > budget.maxEntryBytes
        || value_bytes > budget.maxEntryBytes
        || base_bytes > budget.maxEntryBytes
        || key_bytes > UINT32_MAX
        || value_bytes > UINT32_MAX
        || base_bytes > UINT32_MAX
    ) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup dirty entry is too large.');
    }
    let size = ENTRY_PREFIX_BYTES;
    size = checked_add(size, key_bytes, Number.MAX_SAFE_INTEGER);
    size = checked_add(size, value_bytes, Number.MAX_SAFE_INTEGER);
    return checked_add(size, base_bytes, Number.MAX_SAFE_INTEGER);
}

export function encode_csv_document_backup(
    input: EncodeCsvDocumentBackupInput,
): Uint8Array {
    const prepared = prepare_backup_envelope(input, true);
    const { budget } = prepared;
    if (
        input.dirtyEntries.size > budget.maxDirtyEntries
        || input.dirtyEntries.size > UINT32_MAX
    ) {
        throw new CsvDocumentBackupError('countLimit', 'CSV backup has too many dirty cells.');
    }
    let dirty_section_bytes = 0;
    for (const [key, entry] of input.dirtyEntries) {
        dirty_section_bytes = checked_add(
            dirty_section_bytes,
            csv_document_backup_entry_size(key, entry, budget),
            budget.maxDirtySectionBytes,
        );
    }
    const total = checked_add(
        budget.fixedBytes,
        dirty_section_bytes,
        budget.maxBackupBytes,
    );

    if (total > BUFFER_CONSTANTS.MAX_LENGTH) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup exceeds the runtime buffer limit.');
    }
    const output = Buffer.allocUnsafe(total);
    output.set(MAGIC, 0);
    output.writeUInt16LE(VERSION, 8);
    output.writeUInt16LE(0, 10);
    output.writeUInt32LE(prepared.headerBytes.byteLength, 12);
    output.writeUInt32LE(input.sourceBytes.byteLength, 16);
    output.writeUInt32LE(input.dirtyEntries.size, 20);
    let offset = PREFIX_BYTES;
    output.set(prepared.headerBytes, offset);
    offset += prepared.headerBytes.byteLength;
    output.set(input.sourceBytes, offset);
    offset += input.sourceBytes.byteLength;

    for (const [key, entry] of input.dirtyEntries) {
        const value = serialize_backup_string(entry.value);
        const base = serialize_backup_string(entry.base);
        const key_bytes = Buffer.byteLength(key, 'utf8');
        const value_bytes = Buffer.byteLength(value, 'utf8');
        const base_bytes = Buffer.byteLength(base, 'utf8');
        output.writeUInt32LE(key_bytes, offset);
        output.writeUInt32LE(value_bytes, offset + 4);
        output.writeUInt32LE(base_bytes, offset + 8);
        offset += ENTRY_PREFIX_BYTES;
        offset += output.write(key, offset, key_bytes, 'utf8');
        offset += output.write(value, offset, value_bytes, 'utf8');
        offset += output.write(base, offset, base_bytes, 'utf8');
    }
    return output;
}

function parse_header(bytes: Uint8Array): BackupHeaderV2 {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let value: unknown;
    try {
        value = JSON.parse(decode_utf8(decoder, bytes, 'CSV backup header'));
    } catch (error) {
        if (error instanceof CsvDocumentBackupError) throw error;
        throw new CsvDocumentBackupError('malformed', 'CSV backup header is not valid JSON.', error);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup header is invalid.');
    }
    const header = value as Partial<BackupHeaderV2>;
    const resource = header.resource as Partial<BackupHeaderV2['resource']> | undefined;
    if (
        typeof header.resourceKey !== 'string'
        || !resource
        || typeof resource.scheme !== 'string'
        || typeof resource.authority !== 'string'
        || typeof resource.path !== 'string'
        || typeof resource.query !== 'string'
        || (header.delimiter !== ',' && header.delimiter !== '\t')
        || !is_digest(header.sourceDigest)
    ) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup header is invalid.');
    }
    return {
        resourceKey: header.resourceKey,
        resource: {
            scheme: resource.scheme,
            authority: resource.authority,
            path: resource.path,
            query: resource.query,
        },
        delimiter: header.delimiter,
        targetBasis: validate_target_basis(header.targetBasis),
        sourceDigest: header.sourceDigest,
        recoveryLimits: validate_recovery_limits(header.recoveryLimits),
    };
}

function preflight_dirty_section(
    input: Buffer,
    start: number,
    dirty_count: number,
    limits: ResolvedLimits,
): void {
    const section_bytes = input.byteLength - start;
    if (section_bytes > V2_MAX_DIRTY_SECTION_BYTES) {
        throw new CsvDocumentBackupError(
            'sizeLimit',
            'CSV backup dirty section exceeds its hard size limit.',
        );
    }
    if (dirty_count * ENTRY_PREFIX_BYTES > section_bytes) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup dirty entries are truncated.');
    }

    let offset = start;
    for (let index = 0; index < dirty_count; index++) {
        if (offset + ENTRY_PREFIX_BYTES > input.byteLength) {
            throw new CsvDocumentBackupError('malformed', 'CSV backup dirty entries are truncated.');
        }
        const key_length = input.readUInt32LE(offset);
        const value_length = input.readUInt32LE(offset + 4);
        const base_length = input.readUInt32LE(offset + 8);
        offset += ENTRY_PREFIX_BYTES;
        if (
            key_length > limits.maxEntryBytes
            || value_length > limits.maxEntryBytes
            || base_length > limits.maxEntryBytes
        ) {
            throw new CsvDocumentBackupError('sizeLimit', 'CSV backup dirty entry is too large.');
        }
        const end = offset + key_length + value_length + base_length;
        if (!Number.isSafeInteger(end) || end > input.byteLength) {
            throw new CsvDocumentBackupError('malformed', 'CSV backup dirty entry is truncated.');
        }
        offset = end;
    }
    if (offset !== input.byteLength) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup has trailing data.');
    }
}

function decode_dirty_section(
    input: Buffer,
    start: number,
    dirty_count: number,
    limits: ResolvedLimits,
    validate: CsvDocumentDirtyEntryValidator | undefined,
    collect: boolean,
): ReadonlyMap<string, CsvDirtyEntry> {
    preflight_dirty_section(input, start, dirty_count, limits);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const seen = collect ? undefined : new Set<string>();
    const dirty = new Map<string, CsvDirtyEntry>();
    let offset = start;
    for (let index = 0; index < dirty_count; index++) {
        const key_length = input.readUInt32LE(offset);
        const value_length = input.readUInt32LE(offset + 4);
        const base_length = input.readUInt32LE(offset + 8);
        offset += ENTRY_PREFIX_BYTES;
        const key = decode_utf8(
            decoder,
            input.subarray(offset, offset + key_length),
            'CSV backup key',
        );
        offset += key_length;
        const value = decode_backup_string(
            decoder,
            input.subarray(offset, offset + value_length),
            'CSV backup value',
        );
        offset += value_length;
        const base = decode_backup_string(
            decoder,
            input.subarray(offset, offset + base_length),
            'CSV backup base',
        );
        offset += base_length;
        const duplicated = collect ? dirty.has(key) : seen!.has(key);
        if (!is_cell_key(key) || duplicated) {
            throw new CsvDocumentBackupError(
                'malformed',
                'CSV backup dirty key is invalid or duplicated.',
            );
        }
        if (value === base) {
            throw new CsvDocumentBackupError(
                'malformed',
                `CSV backup dirty entry ${key} is not dirty.`,
            );
        }
        if (collect) {
            const entry = Object.freeze({ value, base });
            validate?.(key, entry);
            dirty.set(key, entry);
        } else {
            seen!.add(key);
        }
    }
    return dirty;
}

export function decode_csv_document_backup_envelope(
    bytes: Uint8Array,
    identity: ResourceIdentity,
    configured_limits: CsvDocumentBackupLimits,
): DecodedCsvDocumentBackupEnvelope {
    // Validate caller-supplied runtime overrides, but do not let mutable source
    // admission replace the immutable recovery admission recorded in the backup.
    resolve_limits(configured_limits);
    if (bytes.byteLength > CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup exceeds its hard size limit.');
    }
    if (bytes.byteLength < PREFIX_BYTES) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup is truncated.');
    }
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < MAGIC.byteLength; index++) {
        if (input[index] !== MAGIC[index]) {
            throw new CsvDocumentBackupError('malformed', 'CSV backup magic is invalid.');
        }
    }
    const version = input.readUInt16LE(8);
    if (version !== VERSION) {
        throw new CsvDocumentBackupError(
            'unsupportedVersion',
            `CSV backup version ${version} is not supported.`,
        );
    }
    if (input.readUInt16LE(10) !== 0) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup flags are invalid.');
    }
    const header_length = input.readUInt32LE(12);
    const source_length = input.readUInt32LE(16);
    const dirty_count = input.readUInt32LE(20);
    if (
        header_length > MAX_HEADER_BYTES
        || source_length > CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES
    ) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup section exceeds its hard size limit.');
    }
    const fixed_length = PREFIX_BYTES + header_length + source_length;
    if (!Number.isSafeInteger(fixed_length) || fixed_length > input.byteLength) {
        throw new CsvDocumentBackupError('malformed', 'CSV backup is truncated.');
    }

    const header = parse_header(input.subarray(PREFIX_BYTES, PREFIX_BYTES + header_length));
    const limits = resolve_limits({
        ...configured_limits,
        maxSourceBytes: header.recoveryLimits.maxSourceBytes,
    });
    if (
        bytes.byteLength > limits.maxBackupBytes
        || source_length > header.recoveryLimits.maxSourceBytes
    ) {
        throw new CsvDocumentBackupError('sizeLimit', 'CSV backup exceeds its recovery size limit.');
    }
    if (dirty_count > limits.maxDirtyEntries) {
        throw new CsvDocumentBackupError('countLimit', 'CSV backup has too many dirty cells.');
    }
    if (header.resourceKey !== identity.key) {
        throw new CsvDocumentBackupError(
            'resourceMismatch',
            'CSV backup belongs to a different resource.',
        );
    }
    if (
        header.targetBasis.stat.size !== source_length
        || header.targetBasis.digest !== header.sourceDigest
    ) {
        throw new CsvDocumentBackupError(
            'malformed',
            'CSV backup target basis does not describe its source bytes.',
        );
    }

    const source_start = PREFIX_BYTES + header_length;
    const dirty_start = source_start + source_length;
    // Reject impossible counts, oversized entries, truncation, and trailing data
    // before hashing or allocating copies of any source or dirty section.
    preflight_dirty_section(input, dirty_start, dirty_count, limits);
    const source_view = input.subarray(source_start, dirty_start);
    if (csv_content_digest(source_view) !== header.sourceDigest) {
        throw new CsvDocumentBackupError(
            'digestMismatch',
            'CSV backup source digest does not match its source bytes.',
        );
    }
    // Intrinsic dirty validity is independent of CSV parsing. Validate it before
    // copying the source or asking the runtime to build a data source.
    decode_dirty_section(input, dirty_start, dirty_count, limits, undefined, false);

    const source_bytes = Uint8Array.from(source_view);
    const encoded_dirty = Uint8Array.from(input.subarray(dirty_start));
    const encoded_dirty_input = Buffer.from(
        encoded_dirty.buffer,
        encoded_dirty.byteOffset,
        encoded_dirty.byteLength,
    );
    return Object.freeze({
        version: 2 as const,
        delimiter: header.delimiter,
        targetBasis: header.targetBasis,
        sourceDigest: header.sourceDigest,
        sourceBytes: source_bytes,
        dirtyCount: dirty_count,
        recoveryLimits: header.recoveryLimits,
        decodeDirtyEntries(validate?: CsvDocumentDirtyEntryValidator) {
            return decode_dirty_section(
                encoded_dirty_input,
                0,
                dirty_count,
                limits,
                validate,
                true,
            );
        },
    });
}

export function decode_csv_document_backup(
    bytes: Uint8Array,
    identity: ResourceIdentity,
    configured_limits: CsvDocumentBackupLimits,
): DecodedCsvDocumentBackup {
    const envelope = decode_csv_document_backup_envelope(
        bytes,
        identity,
        configured_limits,
    );
    return Object.freeze({
        version: envelope.version,
        delimiter: envelope.delimiter,
        targetBasis: envelope.targetBasis,
        sourceDigest: envelope.sourceDigest,
        sourceBytes: envelope.sourceBytes,
        dirtyEntries: envelope.decodeDirtyEntries(),
        recoveryLimits: envelope.recoveryLimits,
    });
}
