import { createHash } from 'crypto';
import type { DataSource } from './data-source/interface';
import { read_source_rows_indexed } from './data-source/interface';
import type { FileStat, FileSystemPort } from './host-ports';
import type { ResourceUriLike } from './resource-identity';
import { serialize_csv, type CsvEditValues } from './serialize-csv';
import {
    is_dirty_map,
    validate_dirty_bases,
    type BaseValidationOutcome,
    type CsvDirtyEntries,
} from './csv-base-validation';
import type { CsvDirtyEntry, CsvSaveRejection } from './types';

const DEFAULT_STABLE_READ_ATTEMPTS = 3;
const DIRTY_ROW_READ_BATCH = 512;
const SERIALIZE_ROW_WINDOW = 10_000;

export interface CsvTargetBasis {
    readonly stat: FileStat;
    readonly digest: string;
}

export interface CsvStableTarget extends CsvTargetBasis {
    readonly bytes: Uint8Array;
}

export interface CsvCancellation {
    readonly isCancellationRequested: boolean;
}

/** The narrow post-save portion of FileRefreshSubscription used by both hosts. */
export interface CsvPostSaveRefresh {
    reserve_post_save(): { cancel(): void };
    request(reason: 'postSave'): Promise<unknown>;
}

export type CsvSaveServiceErrorCode =
    | 'cancelled'
    | 'tooLarge'
    | 'unstableTarget'
    | 'truncated'
    | 'baseMismatch'
    | 'rowsRemoved'
    | 'externalChange'
    | 'writeFailed'
    | 'verificationFailed';

export class CsvSaveServiceError extends Error {
    readonly code: CsvSaveServiceErrorCode;
    readonly keys?: readonly string[];
    override readonly cause?: unknown;

    constructor(
        code: CsvSaveServiceErrorCode,
        message: string,
        options: { readonly keys?: readonly string[]; readonly cause?: unknown } = {},
    ) {
        super(message);
        this.name = 'CsvSaveServiceError';
        this.code = code;
        this.keys = options.keys;
        this.cause = options.cause;
    }
}

export interface PrepareCsvSaveInput {
    readonly source: DataSource;
    readonly delimiter: ',' | '\t';
    /** Value projection used for serialization; independent by contract. */
    readonly edits: CsvEditValues;
    /** Exact value/base projection used only for conflict validation. */
    readonly dirtyEntries: CsvDirtyEntries;
    /** Optional re-encoded header used when Save As changes delimiters. */
    readonly headerLine?: string;
}

export interface PreparedCsvContent {
    readonly type: 'prepared';
    readonly bytes: Uint8Array;
    readonly digest: string;
}

export type PrepareCsvSaveResult =
    | PreparedCsvContent
    | { readonly type: 'rejected'; readonly rejection: CsvSaveRejection };

export interface WriteCsvTargetInput {
    readonly fs: FileSystemPort;
    readonly resource: ResourceUriLike;
    readonly content: PreparedCsvContent;
    readonly maxFileSizeBytes: number;
    /** Omit for Save As: the destination is host-approved and may be overwritten. */
    readonly expectedTarget?: CsvTargetBasis;
    readonly cancellation?: CsvCancellation;
    readonly refresh?: CsvPostSaveRefresh;
}

export type CsvPostSaveCompletion =
    | { readonly type: 'completed' }
    | { readonly type: 'failed'; readonly error: unknown };

export interface WriteCsvTargetResult extends CsvTargetBasis {
    /** Never rejects and deliberately does not delay verified save completion. */
    readonly postSaveCompletion?: Promise<CsvPostSaveCompletion>;
}

function dirty_entries(
    dirty: CsvDirtyEntries,
): Iterable<[string, CsvDirtyEntry]> {
    return is_dirty_map(dirty) ? dirty.entries() : Object.entries(dirty);
}

function same_stat(left: FileStat, right: FileStat): boolean {
    return left.size === right.size && left.mtime === right.mtime;
}

function validate_size(size: number, max_file_size_bytes: number): void {
    if (!Number.isSafeInteger(max_file_size_bytes) || max_file_size_bytes < 0) {
        throw new TypeError('maxFileSizeBytes must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > max_file_size_bytes) {
        throw new CsvSaveServiceError(
            'tooLarge',
            `File exceeds the configured ${max_file_size_bytes}-byte limit.`,
        );
    }
}

function throw_if_cancelled(cancellation: CsvCancellation | undefined): void {
    if (cancellation?.isCancellationRequested) {
        throw new CsvSaveServiceError('cancelled', 'CSV operation was cancelled.');
    }
}

export function csv_content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read a target only when stat/read/stat agrees on one physical observation.
 * No fixed delay is used: callers either receive an observable stable result or
 * an explicit failure after the bounded attempts.
 */
export async function read_csv_target_stably(
    fs: FileSystemPort,
    resource: ResourceUriLike,
    max_file_size_bytes: number,
    cancellation?: CsvCancellation,
    attempts = DEFAULT_STABLE_READ_ATTEMPTS,
): Promise<CsvStableTarget> {
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
        throw new TypeError('Stable read attempts must be a positive safe integer.');
    }

    let last_observation: { before: FileStat; after: FileStat; bytes: number } | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
        throw_if_cancelled(cancellation);
        const before = await fs.stat(resource);
        validate_size(before.size, max_file_size_bytes);
        throw_if_cancelled(cancellation);
        const bytes = await fs.read_file(resource);
        validate_size(bytes.byteLength, max_file_size_bytes);
        throw_if_cancelled(cancellation);
        const after = await fs.stat(resource);
        throw_if_cancelled(cancellation);
        validate_size(after.size, max_file_size_bytes);
        if (same_stat(before, after) && after.size === bytes.byteLength) {
            return {
                bytes,
                stat: Object.freeze({ size: after.size, mtime: after.mtime }),
                digest: csv_content_digest(bytes),
            };
        }
        last_observation = { before, after, bytes: bytes.byteLength };
    }

    throw new CsvSaveServiceError(
        'unstableTarget',
        'The CSV changed while it was being read.',
        { cause: last_observation },
    );
}

function observed_dirty_bases(
    source: DataSource,
    dirty: CsvDirtyEntries,
): Map<string, string | undefined> {
    const sheet = source.meta().sheets[0];
    if (!sheet) throw new RangeError('CSV source has no sheet.');

    const requested = new Map<number, Array<{ readonly key: string; readonly column: number }>>();
    for (const [key] of dirty_entries(dirty)) {
        const [row, column] = key.split(':').map(Number);
        if (
            !Number.isInteger(row)
            || !Number.isInteger(column)
            || row < 0
            || column < 0
            || row >= sheet.sourceRowCount
        ) continue;
        const row_requests = requested.get(row);
        const request = { key, column };
        if (row_requests) row_requests.push(request);
        else requested.set(row, [request]);
    }

    const observed = new Map<string, string | undefined>();
    const rows = [...requested.keys()].sort((left, right) => left - right);
    for (let offset = 0; offset < rows.length; offset += DIRTY_ROW_READ_BATCH) {
        const batch_rows = rows.slice(offset, offset + DIRTY_ROW_READ_BATCH);
        const batch = read_source_rows_indexed(source, 0, batch_rows).rows;
        for (let index = 0; index < batch_rows.length; index++) {
            const row = batch[index] ?? [];
            for (const request of requested.get(batch_rows[index]) ?? []) {
                const cell = row[request.column];
                observed.set(
                    request.key,
                    cell !== null && cell !== undefined ? String(cell.raw ?? '') : undefined,
                );
            }
        }
    }
    return observed;
}

export function validate_csv_dirty_entries(
    source: DataSource,
    dirty: CsvDirtyEntries,
): BaseValidationOutcome {
    const sheet = source.meta().sheets[0];
    if (!sheet) return { type: 'removedRows', keys: [...dirty_entries(dirty)].map(([key]) => key) };
    const observed = observed_dirty_bases(source, dirty);
    return validate_dirty_bases(
        dirty,
        sheet.sourceRowCount,
        (row, column) => observed.get(`${row}:${column}`),
    );
}

/**
 * Validate conflict bases and serialize in the same 10,000-row traversal used by
 * the established self-managed save path. No filesystem or lifecycle policy is
 * hidden in this content-only operation.
 */
export function prepare_csv_save_content(input: PrepareCsvSaveInput): PrepareCsvSaveResult {
    if (input.source.truncationMessage) {
        throw new CsvSaveServiceError(
            'truncated',
            'The CSV was truncated while loading and cannot be saved safely.',
        );
    }

    const sheet = input.source.meta().sheets[0];
    if (!sheet) {
        return {
            type: 'rejected',
            rejection: {
                reason: 'rowsRemoved',
                keys: [...dirty_entries(input.dirtyEntries)].map(([key]) => key),
            },
        };
    }
    const observed_bases = new Map<string, string>();
    const wanted_columns = new Map<number, number[]>();
    for (const [key] of dirty_entries(input.dirtyEntries)) {
        const [source_row, column] = key.split(':').map(Number);
        const columns = wanted_columns.get(source_row);
        if (columns) columns.push(column);
        else wanted_columns.set(source_row, [column]);
    }
    const wants_bases = wanted_columns.size > 0;

    function* row_windows() {
        let absolute_row = 0;
        for (let start = 0; start < sheet.rowCount; start += SERIALIZE_ROW_WINDOW) {
            const { rows } = input.source.read_rows(0, start, SERIALIZE_ROW_WINDOW);
            for (const row of rows) {
                const columns = wants_bases
                    ? wanted_columns.get(absolute_row)
                    : undefined;
                if (columns) {
                    for (const column of columns) {
                        const cell = row[column];
                        if (cell === undefined) continue;
                        observed_bases.set(
                            `${absolute_row}:${column}`,
                            cell === null ? '' : String(cell.raw ?? ''),
                        );
                    }
                }
                absolute_row += 1;
                yield row;
            }
        }
    }

    const text = serialize_csv(
        row_windows(),
        input.delimiter,
        input.edits,
        input.source.originalColumnCounts,
        input.source.lineEnding ?? '\n',
        input.headerLine ?? input.source.headerLine,
    );
    const validation = validate_dirty_bases(
        input.dirtyEntries,
        sheet.sourceRowCount,
        (row, column) => observed_bases.get(`${row}:${column}`),
    );
    if (validation.type !== 'valid') {
        return {
            type: 'rejected',
            rejection: validation.type === 'removedRows'
                ? { reason: 'rowsRemoved', keys: validation.keys }
                : { reason: 'baseMismatch', keys: validation.keys },
        };
    }

    const bytes = new TextEncoder().encode(text);
    return { type: 'prepared', bytes, digest: csv_content_digest(bytes) };
}

function external_change(cause: unknown): CsvSaveServiceError {
    return new CsvSaveServiceError(
        'externalChange',
        'The CSV changed externally after this document was loaded.',
        { cause },
    );
}

/**
 * Compare (normal Save only), perform the final stat, write, and then verify.
 * Cancellation is honored until the write boundary. After write_file is invoked,
 * verification always finishes; post-save refresh is requested only when the
 * intended digest is proven to have landed.
 */
export async function write_csv_target(
    input: WriteCsvTargetInput,
): Promise<WriteCsvTargetResult> {
    throw_if_cancelled(input.cancellation);
    validate_size(input.content.bytes.byteLength, input.maxFileSizeBytes);

    let compared: CsvStableTarget | undefined;
    if (input.expectedTarget) {
        try {
            compared = await read_csv_target_stably(
                input.fs,
                input.resource,
                input.maxFileSizeBytes,
                input.cancellation,
            );
        } catch (error) {
            if (error instanceof CsvSaveServiceError && error.code === 'cancelled') throw error;
            throw external_change(error);
        }
        if (compared.digest !== input.expectedTarget.digest) {
            throw external_change({
                expectedDigest: input.expectedTarget.digest,
                actualDigest: compared.digest,
            });
        }
    }

    throw_if_cancelled(input.cancellation);
    let reservation: { cancel(): void } | undefined;
    let write_error: unknown;
    let verification: CsvStableTarget | undefined;
    let verification_error: unknown;
    let post_save_completion: Promise<CsvPostSaveCompletion> | undefined;

    try {
        if (compared) {
            let final_stat: FileStat;
            try {
                final_stat = await input.fs.stat(input.resource);
            } catch (error) {
                throw external_change(error);
            }
            if (!same_stat(final_stat, compared.stat)) {
                throw external_change({ compared: compared.stat, final: final_stat });
            }
        }
        throw_if_cancelled(input.cancellation);
        reservation = input.refresh?.reserve_post_save();

        // VS Code's workspace.fs API has no conditional or etagged write. The
        // final stat above narrows, but cannot eliminate, the race before this
        // provider-agnostic write without reintroducing physical coordination.
        try {
            await input.fs.write_file(input.resource, input.content.bytes);
        } catch (error) {
            write_error = error;
        }

        try {
            verification = await read_csv_target_stably(
                input.fs,
                input.resource,
                input.maxFileSizeBytes,
            );
        } catch (error) {
            verification_error = error;
        }
    } catch (error) {
        reservation?.cancel();
        throw error;
    }

    if (!verification || verification.digest !== input.content.digest) {
        reservation?.cancel();
        if (write_error) {
            throw new CsvSaveServiceError(
                'writeFailed',
                'The CSV write failed and the intended content could not be verified.',
                { cause: { writeError: write_error, verificationError: verification_error } },
            );
        }
        throw new CsvSaveServiceError(
            'verificationFailed',
            'The CSV write completed but the intended content could not be verified.',
            { cause: verification_error ?? { actualDigest: verification?.digest } },
        );
    }

    if (input.refresh) {
        try {
            post_save_completion = input.refresh.request('postSave').then(
                () => ({ type: 'completed' as const }),
                (error) => ({ type: 'failed' as const, error }),
            );
        } catch (error) {
            reservation?.cancel();
            post_save_completion = Promise.resolve({ type: 'failed' as const, error });
        }
    }

    return {
        stat: verification.stat,
        digest: verification.digest,
        ...(post_save_completion === undefined ? {} : { postSaveCompletion: post_save_completion }),
    };
}
