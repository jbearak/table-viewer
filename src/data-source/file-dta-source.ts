import type { DtaReader, Variable } from '@jbearak/dta-parser';
import { openDtaFile } from '@jbearak/dta-parser/node';
import { stata_observation_bytes, stata_table_shape } from './dta-source';
import { open_file_source, type ObservedFileSource, SourceFile } from './source-file';
import { TableReaderSource } from './table-reader-source';

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
export const MAX_FILE_BACKED_VALUE_LABEL_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BACKED_VALUE_LABEL_ENTRIES = 65_536;
const MAX_FILE_BACKED_DTA_OBSERVATION_BYTES = 1024 * 1024;

export type ObservedFileDtaSource = ObservedFileSource<FileDtaDataSource>;

export function assert_file_backed_dta_row_size(variables: readonly Variable[]): void {
    if (stata_observation_bytes(variables) > MAX_FILE_BACKED_DTA_OBSERVATION_BYTES) {
        throw new Error(
            `Stata observations exceed the `
            + `${MAX_FILE_BACKED_DTA_OBSERVATION_BYTES / 1024 / 1024} MiB per-row safety limit`,
        );
    }
}

/**
 * Decoded value labels of every set a variable uses must stay within budget.
 * `format` names the file's format in the message ("Stata", "Parquet").
 */
export function assert_value_label_limits(
    reader: Pick<DtaReader, 'valueLabels'>,
    variables: readonly Variable[],
    format = 'Stata',
): void {
    let entries = 0;
    let characters = 0;
    const names = new Set(variables.map((variable) => variable.valueLabels));
    for (const name of names) {
        const labels = name ? reader.valueLabels(name) : undefined;
        if (!labels) continue;
        entries += labels.size;
        for (const label of labels.values()) characters += label.length;
    }
    if (entries > MAX_FILE_BACKED_VALUE_LABEL_ENTRIES) {
        throw new Error(
            `${format} value-label data exceeds the `
            + `${MAX_FILE_BACKED_VALUE_LABEL_ENTRIES.toLocaleString('en-US')} entry safety limit`,
        );
    }
    if (characters * 2 > MAX_FILE_BACKED_VALUE_LABEL_BYTES) {
        throw new Error(`Decoded ${format} value-label data exceeds the memory safety limit`);
    }
}

/**
 * Node-backed Stata source for files that cannot be represented by one host
 * `readFile()` result. The reader keeps this source's descriptor and reads
 * the byte ranges it needs on demand.
 */
export class FileDtaDataSource extends TableReaderSource<DtaReader> {
    private constructor(
        reader: DtaReader,
        private readonly file: SourceFile | null,
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
        super(reader, stata_table_shape(reader));
    }

    static async open(file_path: string): Promise<FileDtaDataSource> {
        return (await FileDtaDataSource.open_observed(file_path, false)).source;
    }

    static open_observed(
        file_path: string,
        include_digest = true,
        is_cancelled: () => boolean = () => false,
    ): Promise<ObservedFileDtaSource> {
        return open_file_source(file_path, 'Stata', include_digest, is_cancelled, (file) => {
            const reader = openDtaFile(file.descriptor);
            try {
                assert_file_backed_dta_row_size(reader.variables);
                assert_value_label_limits(reader, reader.variables);
                return new FileDtaDataSource(reader, file);
            } catch (error) {
                reader.close();
                throw error;
            }
        });
    }

    close(): void {
        super.close();
        this.file?.close();
    }

    async physical_content_matches(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        this.open_reader();
        if (this.file === null) throw new Error('Stata source is closed');
        return this.file.physical_content_matches(expected_digest, is_cancelled);
    }
}
