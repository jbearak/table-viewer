import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DtaReader, Variable } from '@jbearak/dta-parser';
import { openDtaFile } from '@jbearak/dta-parser/node';
import { StataReaderSource, stata_observation_bytes } from './dta-source';

/**
 * A wide DTA remains cheap to address because rows stay on disk, but every row
 * still crosses the host/webview boundary as one array. Keep a corruption guard
 * without applying the buffer-backed source's 50-million-materialized-cell
 * budget to a source that never materializes the full table.
 */
export const MAX_FILE_BACKED_DTA_COLUMNS = 10_000;
// Paging avoids retaining every cell, but transforms and variable row heights
// still keep or visit row-count-sized structures. Two million admits the DHS
// dataset that motivated this source while bounding each typed row-index array
// to 8 MiB and keeping those whole-sheet passes finite.
export const MAX_FILE_BACKED_DTA_ROWS = 2_000_000;
const MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES = 65_536;
const MAX_FILE_BACKED_DTA_OBSERVATION_BYTES = 1024 * 1024;
const FILE_DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ObservedFileDtaSource {
    readonly source: FileDtaDataSource;
    readonly digest: string;
    readonly size: number;
    readonly mtime: number;
}

export function assert_file_backed_dta_row_size(variables: readonly Variable[]): void {
    if (stata_observation_bytes(variables) > MAX_FILE_BACKED_DTA_OBSERVATION_BYTES) {
        throw new Error(
            `Stata observations exceed the `
            + `${MAX_FILE_BACKED_DTA_OBSERVATION_BYTES / 1024 / 1024} MiB per-row safety limit`,
        );
    }
}

/** Decoded value labels of every set a variable uses must stay within budget. */
function assert_value_label_limits(reader: DtaReader): void {
    let entries = 0;
    let characters = 0;
    const names = new Set(reader.variables.map((variable) => variable.valueLabels));
    for (const name of names) {
        const labels = name ? reader.valueLabels(name) : undefined;
        if (!labels) continue;
        entries += labels.size;
        for (const label of labels.values()) characters += label.length;
    }
    if (entries > MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES) {
        throw new Error(
            `Stata value-label data exceeds the `
            + `${MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES.toLocaleString('en-US')} entry safety limit`,
        );
    }
    if (characters * 2 > MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES) {
        throw new Error('Decoded Stata value-label data exceeds the memory safety limit');
    }
}

function abort_error(): Error {
    const error = new Error('Stata source open was cancelled.');
    error.name = 'AbortError';
    return error;
}

async function digest_descriptor(
    fd: number,
    size: number,
    is_cancelled: () => boolean,
): Promise<string> {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(FILE_DIGEST_CHUNK_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
        if (is_cancelled()) throw abort_error();
        const length = Math.min(chunk.byteLength, size - position);
        const bytes_read = await new Promise<number>((resolve, reject) => {
            fs.read(fd, chunk, 0, length, position, (error, read) => {
                if (error) reject(error);
                else resolve(read);
            });
        });
        if (bytes_read === 0) throw new Error('Unexpected EOF while hashing Stata file');
        digest.update(chunk.subarray(0, bytes_read));
        position += bytes_read;
    }
    if (is_cancelled()) throw abort_error();
    return digest.digest('hex');
}

function same_descriptor(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs;
}

/**
 * Node-backed Stata source for files that cannot be represented by one host
 * `readFile()` result. The reader keeps this source's descriptor and reads
 * the byte ranges it needs on demand.
 */
export class FileDtaDataSource extends StataReaderSource {
    private fd: number | null;

    private constructor(
        reader: DtaReader,
        fd: number | null,
        private readonly file_path: string,
    ) {
        if (reader.info.nobs > MAX_FILE_BACKED_DTA_ROWS) {
            throw new Error(
                `Stata dataset has too many observations to open safely `
                + `(max ${MAX_FILE_BACKED_DTA_ROWS.toLocaleString('en-US')})`,
            );
        }
        if (reader.variables.length > MAX_FILE_BACKED_DTA_COLUMNS) {
            throw new Error(
                `Stata dataset has too many variables to open safely `
                + `(max ${MAX_FILE_BACKED_DTA_COLUMNS.toLocaleString('en-US')})`,
            );
        }
        super(reader);
        this.fd = fd;
    }

    static async open(file_path: string): Promise<FileDtaDataSource> {
        return (await FileDtaDataSource.open_observed(file_path, false)).source;
    }

    static async open_observed(
        file_path: string,
        include_digest = true,
        is_cancelled: () => boolean = () => false,
    ): Promise<ObservedFileDtaSource> {
        let fd: number | undefined;
        let reader: DtaReader | undefined;
        try {
            if (is_cancelled()) throw abort_error();
            const opened_fd = fs.openSync(file_path, 'r');
            fd = opened_fd;
            const opened = openDtaFile(opened_fd);
            reader = opened;
            assert_file_backed_dta_row_size(opened.variables);
            assert_value_label_limits(opened);
            if (is_cancelled()) throw abort_error();
            const source = new FileDtaDataSource(opened, opened_fd, file_path);
            reader = undefined;
            fd = undefined;
            try {
                return include_digest
                    ? await source.observe_file(is_cancelled)
                    : source.observe_file_without_digest();
            } catch (error) {
                source.close();
                throw error;
            }
        } catch (error) {
            reader?.close();
            if (fd !== undefined) fs.closeSync(fd);
            if (error instanceof Error && error.name === 'AbortError') throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }

    close(): void {
        super.close();
        if (this.fd !== null) {
            const fd = this.fd;
            this.fd = null;
            fs.closeSync(fd);
        }
    }

    async physical_content_matches(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        const fd = this.open_fd();
        const before = fs.fstatSync(fd);
        const digest = await digest_descriptor(fd, before.size, is_cancelled);
        const after = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        return digest === expected_digest
            && same_descriptor(before, after)
            && same_descriptor(after, path_stat);
    }

    private open_fd(): number {
        this.open_reader();
        if (this.fd === null) throw new Error('Stata source is closed');
        return this.fd;
    }

    private observe_file_without_digest(): ObservedFileDtaSource {
        const descriptor = fs.fstatSync(this.open_fd());
        const path_stat = fs.statSync(this.file_path);
        if (!same_descriptor(descriptor, path_stat)) {
            throw new Error('The file changed while it was being opened.');
        }
        return { source: this, digest: '', size: descriptor.size, mtime: descriptor.mtime.getTime() };
    }

    private async observe_file(is_cancelled: () => boolean): Promise<ObservedFileDtaSource> {
        const fd = this.open_fd();
        const before = fs.fstatSync(fd);
        const digest = await digest_descriptor(fd, before.size, is_cancelled);
        const after = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        if (!same_descriptor(before, after) || !same_descriptor(after, path_stat)) {
            throw new Error('The file changed while it was being opened.');
        }
        return { source: this, digest, size: after.size, mtime: after.mtime.getTime() };
    }
}
