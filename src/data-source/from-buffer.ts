// Format-dispatching DataSource factory shared by the normal load path and the
// git-compare session, so both sides of a compare parse identically.
import type { DataSource } from './interface';
import { CsvDataSource } from './csv-source';
import { XlsxDataSource } from './xlsx-source';
import { XlsDataSource } from './xls-source';
import { ExcelHeaderDataSource } from './excel-header-source';
import { get_delimiter } from '../host-ports';
import type { ExcelHeaderOverride } from './interface';

export interface FromBufferOptions {
    /** CSV/TSV row cap; callers pass the configured limit. Default: unlimited. */
    readonly csvMaxRows?: number;
    /** Excel first-row-header persisted overrides (auto-detect when absent). */
    readonly excelHeaderOverrides?: Record<string, ExcelHeaderOverride>;
    /** Rows hidden by transforms, consulted by Excel header planning. */
    readonly excelHiddenRows?: readonly (readonly number[] | undefined)[];
}

/**
 * Build a DataSource for raw file bytes, dispatched on the path's extension the
 * same way `profile_for` dispatches profiles: `.csv`/`.tsv` → CSV (first row is
 * the header), `.xlsx` → OOXML, anything else → BIFF `.xls`.
 */
export async function build_source_from_buffer(
    raw: Uint8Array,
    file_path: string,
    options: FromBufferOptions = {},
): Promise<DataSource> {
    const ext = file_path.toLowerCase();
    if (ext.endsWith('.csv') || ext.endsWith('.tsv')) {
        const max_rows = options.csvMaxRows ?? Number.MAX_SAFE_INTEGER;
        return CsvDataSource.create(raw, get_delimiter(file_path), max_rows, {
            firstRowIsHeader: true,
        });
    }
    const physical = ext.endsWith('.xlsx')
        ? await XlsxDataSource.create(raw)
        : await XlsDataSource.create(Buffer.from(raw));
    return new ExcelHeaderDataSource(
        physical,
        options.excelHeaderOverrides,
        options.excelHiddenRows,
    );
}
